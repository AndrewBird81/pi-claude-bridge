/**
 * A host that runs its own agent loop over the provider (one built on pi-durable)
 * differs from pi in two ways upstream does not already absorb. Both are driven here
 * through the real streamSimple with a scripted SDK — no Claude Code subprocess runs.
 *
 * 1. It never reports the prompt it assembled (no agent_start / turn_start), so no
 *    capture key can match. The transcript's named sections say what is portable.
 * 2. It scopes the abort signal to one streamSimple call and ends it, with pi-durable's
 *    "invocation has ended" reason, when the call returns — while the query that call
 *    opened is parked at a tool call. That is not a user abort.
 *
 * Each case also pins what pi must keep doing: the gates are what stop these paths
 * from changing a pi session.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";

const root = process.env.CLAUDE_CONFIG_DIR;
const { default: activate, __test } = await import("../src/index.js");
const { captureFromSections, projectPromptCapture } = await import("../src/prompt-capture.js");
const { setQuery, resetSharedSession, activeQueryContexts } = __test;

let providerConfig;
activate({ on: () => {}, registerProvider: (_name, config) => { providerConfig = config; } });
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

const READ = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
const user = (content) => ({ role: "user", content, timestamp: 1 });
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 1 });
const system = (sections) => ({ role: "system", content: "", sections, toolsAdded: [READ], timestamp: 1 });
const gate = () => { let open; const wait = new Promise((r) => { open = r; }); return { wait, open }; };
const settle = () => new Promise((r) => setTimeout(r, 20));
/** pi-durable's end-of-invocation abort, as its scheduler raises it. */
const callEnded = (controller) => controller.abort(new Error("Task 7 invocation has ended"));

// A scripted SDK that writes its live records, as Claude Code would.
let scripts, queries;
beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	scripts = [];
	queries = [];
	setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		assert.ok(script, "script queued");
		const sessionId = options.sessionId ?? options.resume;
		const query = { options, stops: [] };
		queries.push(query);
		const path = getSessionPath(sessionId, options.cwd, root);
		let parentUuid = null;
		const record = (role, content, uuid) => {
			const builder = createSession({ projectPath: options.cwd, sessionId });
			if (role === "assistant") builder.addAssistantMessage(content);
			else builder.addUserMessage(content);
			const value = { ...builder.records[0], ...(uuid ? { uuid } : {}), parentUuid };
			parentUuid = value.uuid;
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, JSON.stringify(value) + "\n");
			return value;
		};
		const gen = (async function* () {
			const input = prompt[Symbol.asyncIterator]();
			const initial = (await input.next()).value;
			void input.next().catch(() => {});
			record("user", initial.message.content, initial.uuid);
			yield { type: "system", subtype: "init", session_id: sessionId };
			yield { type: "user", isReplay: true, parent_tool_use_id: null, uuid: initial.uuid, session_id: sessionId, message: initial.message };
			const assistant = (content, id) => {
				const value = record("assistant", content);
				return { type: "assistant", parent_tool_use_id: null, uuid: value.uuid, session_id: sessionId, message: { id, model: model.id, content } };
			};
			if (script.tool) {
				yield assistant([{ type: "tool_use", id: script.tool, name: "mcp__custom-tools__read", input: { path: "a" } }], `msg_${script.tool}`);
				await script.wait;
				const value = record("user", [{ type: "tool_result", tool_use_id: script.tool, content: "file" }]);
				yield { type: "user", parent_tool_use_id: null, uuid: value.uuid, message: value.message };
			}
			yield assistant([{ type: "text", text: "answer" }], `msg_final_${sessionId}`);
			yield { type: "result", subtype: "success", is_error: false, result: "answer", session_id: sessionId };
		})();
		gen.interrupt = async () => { query.stops.push("interrupt"); };
		gen.close = () => { query.stops.push("close"); };
		return gen;
	});
});
afterEach(() => setQuery(null));

describe("a prompt the host never reported", () => {
	const STOCK = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files.";
	const project = (sections, hasReadTool = true) =>
		projectPromptCapture(captureFromSections("key", { content: "", sections: new Map(Object.entries(sections)) }, { hasReadTool }), { hasReadTool });

	it("forwards the sections that are not pi's harness", async () => {
		scripts.push({});
		const sections = {
			preamble: STOCK,
			tools: "<tools>\n- read: Read a file\n</tools>",
			rules: "<rules>\n- Be concise in your responses\n</rules>",
			project_context: "<project_context>\nAlways run the linter.\n</project_context>",
			cwd: "<cwd>\n/work/repo\n</cwd>",
			team_policy: "<team_policy>\nNever push to main.\n</team_policy>",
		};
		const out = await streamSimple(model, { messages: [system(sections), user("hi")] }, { sessionId: "sections-1" }).result();

		assert.equal(out.stopReason, "stop", out.errorMessage);
		const append = queries[0].options.systemPrompt.append;
		assert.match(append, /Always run the linter\./);
		assert.match(append, /\/work\/repo/);
		assert.match(append, /Never push to main\./, "a section the bridge has never heard of is the host's own text");
		assert.doesNotMatch(append, /operating inside pi/, "pi's stock preamble is pi's harness, not the user's prompt");
		assert.doesNotMatch(append, /Read a file|Be concise/, "Claude Code's preset has its own tool list and rules");
	});

	it("keeps a preamble that is the host's own prompt, tagged or not", () => {
		for (const preamble of ["You are a coding agent reached through Slack.", "<preamble>\nYou are a release bot.\n</preamble>"]) {
			assert.equal(project({ preamble }), preamble);
		}
		assert.equal(project({ preamble: `<preamble>\n${STOCK}\n</preamble>` }), undefined, "the stock preamble inside its tag is still the stock preamble");
	});

	it("forwards skills only when the model can read them, through the MCP read tool", () => {
		const skills = "<skills>\nUse the read tool to load a skill's file.\n</skills>";
		assert.equal(project({ skills }, false), undefined);
		assert.match(project({ skills }), /mcp__custom-tools__read/);
	});
});

describe("an opening call whose signal ends with the call", () => {
	it("leaves the parked query running, and the next call continues it", async () => {
		const S = "scoped-1", g = gate(), ask = user("read a");
		scripts.push({ tool: "toolu_1", wait: g.wait });

		const first = new AbortController();
		const toolTurn = await streamSimple(model, { messages: [ask], tools: [READ] }, { sessionId: S, signal: first.signal }).result();
		assert.equal(toolTurn.stopReason, "toolUse");
		callEnded(first);
		await settle();
		assert.deepEqual(queries[0].stops, [], "the request returning is not the user stopping the turn");

		const second = new AbortController();
		const delivery = streamSimple(model, { messages: [ask, toolTurn, toolResult("toolu_1")], tools: [READ] }, { sessionId: S, signal: second.signal });
		g.open();
		const answer = await delivery.result();

		assert.equal(answer.stopReason, "stop", answer.errorMessage);
		assert.equal(queries.length, 1, "one Claude Code query served the whole turn");
	});

	it("still stops a parked query on any other abort (pi's run-scoped signal)", async () => {
		// pi aborts bare; pi-subagents stops children with a plain Error. Neither is a call ending.
		for (const [index, reason] of [undefined, new Error("Workflow stopped.")].entries()) {
			const g = gate();
			scripts.push({ tool: `toolu_2_${index}`, wait: g.wait });
			const controller = new AbortController();
			await streamSimple(model, { messages: [user("read a")], tools: [READ] }, { sessionId: `scoped-2-${index}`, signal: controller.signal }).result();

			controller.abort(reason);
			await settle();
			assert.ok(queries[index].stops.includes("interrupt"), `abort(${reason?.message ?? ""}) while parked stops the query`);
			g.open();
			await settle();
		}
	});
});

// Last: the flag it sets is process-wide and sticky.
describe("once the host reports live prompts (pi)", () => {
	it("an unmatched prompt fails the turn as before, sections or not", async () => {
		__test.promptCaptures.record("the prompt pi reported", { contextFiles: [], skills: [] }, "turn_start");
		const sections = { preamble: "You are a release bot.", cwd: "/work/repo" };
		const out = await streamSimple(model, { messages: [system(sections), user("hi")] }, { sessionId: "pi-1" }).result();

		assert.equal(out.stopReason, "error");
		assert.match(out.errorMessage, /prompt-capture: no capture/);
		assert.equal(queries.length, 0);
	});
});
