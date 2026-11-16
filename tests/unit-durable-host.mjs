/**
 * A host that runs its own agent loop over the provider (one built on pi-durable)
 * differs from pi in five ways the bridge has to absorb. Each is driven here through
 * the real streamSimple with a mocked SDK query() — no Claude Code subprocess runs.
 *
 * 1. It never reports the prompt it assembled (no agent_start / turn_start), so no
 *    capture key can match. The transcript's named sections say what is portable.
 * 2. It scopes the abort signal to one streamSimple call and ends it, with pi-durable's
 *    "invocation has ended" reason, when the call returns — while the query that call
 *    started is parked at a tool boundary. That is not a user abort.
 * 3. It resumes a turn in a new process after a crash: the transcript ends with a tool
 *    result this process never asked for, and the turn is still owed an answer.
 * 4. An abort during a tool reaches no call at all. The session's next message normally
 *    arrives behind the aborted tool's result and continues the parked query; when the
 *    transcript no longer holds that tool call, the next turn retires the query instead.
 *
 * 5. It compacts history mid-turn without a session_compact event. The transcript's
 *    changed head is the sign that a parked query now holds a stale context.
 *
 * Every case also pins what pi must keep doing: the gates are what stop these paths
 * from changing a pi session.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before importing the module: config, CC paths and the diag log resolve at import
// time. An agent dir with its own (empty) config keeps the user's accounts out, so
// session files land in the throwaway CLAUDE_CONFIG_DIR.
const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-durable-host-"));
const agentDir = join(tmpRoot, "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({ startupNoticeShown: "2026-01-01" }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CLAUDE_CONFIG_DIR = join(tmpRoot, "claude");
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

const { default: activate, __test } = await import("../src/index.js");
const { captureFromSections, projectPromptCapture, PI_PREAMBLE } = await import("../src/prompt-capture.js");
const { setQuery, resetSharedSession, activeQueryContexts } = __test;

let providerConfig;
activate({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

// --- fake SDK query: one script per query, popped in order ---
const queries = [];
const scripts = [];
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const ev = (event) => ({ type: "stream_event", event });
const toolUse = (id) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const result = (text) => ({ type: "result", subtype: "success", is_error: false, result: text });

// --- pi-side messages ---
let clock = 0;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const toolCall = (id) => ({
	role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
	api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse", timestamp: clock++,
});
const toolResult = (id, text = "file") => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: clock++ });
// The bridge serves pi's tools to Claude Code over MCP and ignores a tool_use for one it does not serve.
const READ = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
const system = (sections) => ({ role: "system", content: "", sections, toolsAdded: [READ], timestamp: clock++ });

const settle = () => new Promise((r) => setTimeout(r, 20));
/** pi-durable's end-of-invocation abort, as its scheduler raises it. */
const callEnded = (controller) => controller.abort(new Error("Task 7 invocation has ended"));

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	queries.length = 0;
	scripts.length = 0;
	setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		const record = { options, prompt, stops: [] };
		queries.push(record);
		const gen = (async function* () {
			for (const step of script) {
				if (typeof step === "function") { await step(); continue; }
				yield options.resume && step.type === "system" ? { ...step, session_id: options.resume } : step;
			}
		})();
		gen.interrupt = async () => { record.stops.push("interrupt"); };
		gen.close = () => { record.stops.push("close"); };
		return gen;
	});
});
afterEach(() => setQuery(null));

/** The text of the first user message the bridge wrote to the query's stdin. */
async function firstPrompt(record) {
	const { value } = await record.prompt[Symbol.asyncIterator]().next();
	const content = value.message.content;
	return typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");
}

describe("a prompt the host never reported", () => {
	const STOCK = `${PI_PREAMBLE}, a coding agent harness. You help users by reading files.`;

	it("forwards the sections that are not pi's harness", async () => {
		scripts.push([init("cc-1"), result("ok")]);
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
		assert.doesNotMatch(append, /operating inside pi/, "pi's stock preamble would read as a third-party app");
		assert.doesNotMatch(append, /Read a file|Be concise/, "Claude Code's preset has its own tool list and rules");
	});

	it("keeps a preamble that is the host's own prompt, tagged or not", () => {
		for (const preamble of ["You are a coding agent reached through Slack.", "<preamble>\nYou are a release bot.\n</preamble>"]) {
			const capture = captureFromSections("key", { content: "", sections: new Map([["preamble", preamble]]) }, { skillReadTool: "mcp" });
			assert.equal(projectPromptCapture(capture, { skillReadTool: "mcp" }), preamble);
		}
		const tagged = captureFromSections("key", { content: "", sections: new Map([["preamble", `<preamble>\n${STOCK}\n</preamble>`]]) }, { skillReadTool: "mcp" });
		assert.equal(projectPromptCapture(tagged, { skillReadTool: "mcp" }), undefined, "the stock preamble inside its tag is still the stock preamble");
	});

	it("forwards skills only when the model can read them, through the MCP read tool", () => {
		const parts = { content: "", sections: new Map([["skills", "<skills>\nUse the read tool to load a skill's file.\n</skills>"]]) };
		assert.equal(captureFromSections("key", parts, { skillReadTool: "none" }).custom, undefined);
		assert.match(captureFromSections("key", parts, { skillReadTool: "mcp" }).custom, /mcp__custom-tools__read/);
	});

	it("fails the turn when pi's harness arrives under a section it does not drop", async () => {
		const sections = { preamble: "You are a release bot.", notes: STOCK };
		const out = await streamSimple(model, { messages: [system(sections), user("hi")] }, { sessionId: "sections-2" }).result();

		assert.equal(out.stopReason, "error");
		assert.match(out.errorMessage, /prompt-capture: refusing to send this prompt/);
		assert.equal(queries.length, 0);
	});
});

describe("a signal scoped to one call", () => {
	it("leaves the parked query running when the call's signal ends with the call", async () => {
		const S = "scoped-1", g = gate();
		const u1 = user("read a"), a1 = toolCall("toolu_1"), tr1 = toolResult("toolu_1");
		scripts.push([init("cc-s1"), ...toolUse("toolu_1"), g.wait, result("done")]);

		const first = new AbortController();
		const turn1 = await streamSimple(model, { messages: [u1], tools: [READ] }, { sessionId: S, signal: first.signal }).result();
		assert.equal(turn1.stopReason, "toolUse");
		callEnded(first);
		await settle();
		assert.deepEqual(queries[0].stops, [], "the request returning is not the user stopping the turn");

		const second = new AbortController();
		const delivery = streamSimple(model, { messages: [u1, a1, tr1], tools: [READ] }, { sessionId: S, signal: second.signal });
		g.open();
		const turn2 = await delivery.result();

		assert.equal(turn2.stopReason, "stop", turn2.errorMessage);
		assert.equal(queries.length, 1, "one Claude Code query served the whole turn");
	});

	it("stops the query when the current call's signal is aborted for real", async () => {
		const S = "scoped-2", g = gate();
		const u1 = user("read a"), a1 = toolCall("toolu_2"), tr1 = toolResult("toolu_2");
		scripts.push([init("cc-s2"), ...toolUse("toolu_2"), g.wait, result("done")]);

		const first = new AbortController();
		await streamSimple(model, { messages: [u1], tools: [READ] }, { sessionId: S, signal: first.signal }).result();
		callEnded(first);

		const second = new AbortController();
		const delivery = streamSimple(model, { messages: [u1, a1, tr1], tools: [READ] }, { sessionId: S, signal: second.signal });
		await settle();
		second.abort();
		g.open();
		const turn2 = await delivery.result();

		assert.equal(turn2.stopReason, "aborted");
		assert.ok(queries[0].stops.includes("interrupt"), "the abort reached the query through the second call's signal");
	});

	it("still stops a parked query on any other abort (pi's run-scoped signal)", async () => {
		// pi aborts bare; pi-subagents stops children with a plain Error. Neither is a call ending.
		for (const [index, reason] of [undefined, new Error("Workflow stopped.")].entries()) {
			const g = gate();
			scripts.push([init(`cc-s3-${index}`), ...toolUse(`toolu_3_${index}`), g.wait, result("done")]);
			const controller = new AbortController();
			await streamSimple(model, { messages: [user("read a")], tools: [READ] }, { sessionId: `scoped-3-${index}`, signal: controller.signal }).result();

			controller.abort(reason);
			await settle();
			assert.ok(queries[index].stops.includes("interrupt"), `abort(${reason?.message ?? ""}) while parked stops the query`);
			g.open();
			await settle();
		}
	});
});

describe("a turn resumed by a process that never started it", () => {
	it("continues from the tool result instead of ending the turn", async () => {
		const u1 = user("read a"), a1 = toolCall("toolu_cold"), tr1 = toolResult("toolu_cold", "was interrupted");
		scripts.push([init("cc-cold"), result("recovered")]);

		const out = await streamSimple(model, { messages: [u1, a1, tr1], tools: [READ] }, { sessionId: "cold-1" }).result();

		assert.equal(out.stopReason, "stop", out.errorMessage);
		assert.equal(queries.length, 1, "a query runs: the turn is still owed an answer");
		assert.ok(queries[0].options.resume, "over a session rebuilt from the transcript");
		assert.match(await firstPrompt(queries[0]), /host process restarted/);
	});

	it("still ends the turn on an orphaned result in a session this process served (pi after an abort)", async () => {
		const S = "cold-2", g = gate();
		const u1 = user("read a"), a1 = toolCall("toolu_orphan"), tr1 = toolResult("toolu_orphan", "aborted");
		scripts.push([init("cc-orphan"), ...toolUse("toolu_orphan"), g.wait, result("never")]);
		const controller = new AbortController();
		await streamSimple(model, { messages: [u1], tools: [READ] }, { sessionId: S, signal: controller.signal }).result();
		controller.abort();
		g.open();
		await settle();

		const out = await streamSimple(model, { messages: [u1, a1, tr1], tools: [READ] }, { sessionId: S }).result();

		assert.equal(out.stopReason, "stop");
		assert.deepEqual(out.content, []);
		assert.equal(queries.length, 1, "no second query: the user stopped this turn");
	});
});

describe("a turn aborted while its query was parked", () => {
	// The host settles the abort on its own side: no call is in flight, so nothing reaches the bridge.
	it("is continued by the session's next message, which arrives behind the aborted tool's result", async () => {
		const S = "aborted-1", g = gate();
		const u1 = user("read a"), a1 = toolCall("toolu_ab"), tr1 = toolResult("toolu_ab", "Tool read was aborted"), u2 = user("never mind");
		scripts.push([init("cc-ab"), ...toolUse("toolu_ab"), g.wait, result("ok")]);
		const first = new AbortController();
		await streamSimple(model, { messages: [u1], tools: [READ] }, { sessionId: S, signal: first.signal }).result();
		callEnded(first);

		const next = streamSimple(model, { messages: [u1, a1, tr1, u2], tools: [READ] }, { sessionId: S });
		g.open();
		const out = await next.result();

		assert.equal(out.stopReason, "stop", out.errorMessage);
		assert.equal(queries.length, 1, "the parked query takes the result and the message as a steer");
		assert.deepEqual(queries[0].stops, []);
	});

	it("is retired by the session's next turn when the transcript no longer holds its tool call", async () => {
		const S = "aborted-2", OTHER = "aborted-other", g = gate(), gOther = gate();
		scripts.push([init("cc-dead"), ...toolUse("toolu_dead"), g.wait, result("never")]);
		const first = new AbortController();
		await streamSimple(model, { messages: [user("read a")], tools: [READ] }, { sessionId: S, signal: first.signal }).result();
		callEnded(first);

		scripts.push([init("cc-other"), ...toolUse("toolu_other"), gOther.wait, result("other done")]);
		const other = new AbortController();
		await streamSimple(model, { messages: [user("other work")], tools: [READ] }, { sessionId: OTHER, signal: other.signal }).result();
		callEnded(other);
		await settle();

		// Compacted since: the result has nothing to route by, so this is a fresh query.
		scripts.push([init("cc-next"), result("second answer")]);
		const out = await streamSimple(model, { messages: [user("summary of earlier work"), user("try again")], tools: [READ] }, { sessionId: S }).result();

		assert.equal(out.stopReason, "stop", out.errorMessage);
		assert.equal(queries.length, 3);
		assert.ok(queries[0].stops.includes("close"), "the dead turn's Claude Code query is stopped, not left running beside its successor");
		assert.deepEqual(queries[1].stops, [], "another session's parked query is still mid-turn");
		g.open();
		gOther.open();
		await settle();
	});
});

describe("history compacted under a parked query", () => {
	// pi announces this with session_compact. A host running its own loop does not, and a
	// result delivered into the parked query would be answered over the uncompacted
	// context: usage never drops and the host compacts again at every tool call.
	it("rebuilds from the compacted history instead of delivering into the stale query", async () => {
		const S = "compacted-1", g = gate();
		const u1 = user("read a"), a1 = toolCall("toolu_c"), tr1 = toolResult("toolu_c");
		scripts.push([init("cc-stale"), ...toolUse("toolu_c"), g.wait, result("stale answer")]);
		await streamSimple(model, { messages: [u1], tools: [READ] }, { sessionId: S }).result();

		scripts.push([init("cc-rebuilt"), result("fresh answer")]);
		const summary = user("Summary of the conversation so far.");
		const out = await streamSimple(model, { messages: [summary, a1, tr1], tools: [READ] }, { sessionId: S }).result();

		assert.equal(out.stopReason, "stop", out.errorMessage);
		assert.equal(queries.length, 2, "a fresh query over the compacted history");
		assert.ok(queries[0].stops.includes("close"), "the query holding the old context is stopped");
		assert.match(await firstPrompt(queries[1]), /context was compacted/);
		g.open();
		await settle();
	});
});

// Last: the flag it sets is process-wide and sticky.
describe("once the host reports live prompts (pi)", () => {
	it("a changed transcript head alone does not discard a parked query", async () => {
		__test.promptCaptures.record("the prompt pi reported", { contextFiles: [], skills: [] }, "turn_start");
		const S = "pi-head", g = gate();
		const u1 = user("read a"), a1 = toolCall("toolu_p"), tr1 = toolResult("toolu_p");
		scripts.push([init("cc-pi"), ...toolUse("toolu_p"), g.wait, result("answer")]);
		await streamSimple(model, { messages: [u1], tools: [READ] }, { sessionId: S }).result();

		const delivery = streamSimple(model, { messages: [user("a context hook rewrote this"), a1, tr1], tools: [READ] }, { sessionId: S });
		g.open();
		const out = await delivery.result();

		assert.equal(out.stopReason, "stop", out.errorMessage);
		assert.equal(queries.length, 1, "pi announces rewrites with session_compact; nothing else discards");
		assert.deepEqual(queries[0].stops, []);
	});

	it("an unmatched prompt fails the turn as before, sections or not", async () => {
		__test.promptCaptures.record("the prompt pi reported", { contextFiles: [], skills: [] }, "turn_start");
		const sections = { preamble: "You are a release bot.", cwd: "/work/repo" };
		const out = await streamSimple(model, { messages: [system(sections), user("hi")] }, { sessionId: "pi-1" }).result();

		assert.equal(out.stopReason, "error");
		assert.match(out.errorMessage, /prompt-capture: no capture/);
		assert.equal(queries.length, 0);
	});
});
