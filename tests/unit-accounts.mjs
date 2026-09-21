/**
 * Multi-account support: account resolution from provider.accounts config,
 * per-provider registration, and how sessions and thinking behave across accounts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";
import { convertPiMessages } from "../src/convert.js";
import { digestMessage } from "../src/message-digests.js";

// Activation reads the config once, so the accounts it registers are written first.
const workDir = mkdtempSync(join(tmpdir(), "accounts-workdir-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));
const ACCOUNTS = { defaultAccountName: "personal", accounts: { work: { configDir: workDir, plan: "max" } } };
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "claude-bridge.json"), JSON.stringify({ provider: ACCOUNTS }));

const { default: activate, __test } = await import("../src/index.js");
const registered = [];
activate({ on: () => {}, registerProvider: (id, config) => registered.push({ id, config }) });

const WORK = { configDir: "~/.claude-work", plan: "max" };

describe("account resolution", () => {
	afterEach(() => __test.configureAccounts({}));

	it("maps provider ids to accounts, default for anything else", () => {
		__test.configureAccounts({ plan: "pro", accounts: { work: WORK } });
		const work = __test.accountFor("claude-bridge-work");
		assert.equal(work.claudeDir, join(homedir(), ".claude-work"), "~ must expand to the home directory");
		assert.equal(work.longContext.plan, "max");
		assert.equal(__test.accountFor("claude-bridge").claudeDir, undefined, "the default account must keep using the process env dir");
		assert.equal(__test.accountFor("claude-bridge").longContext.plan, "pro");
		assert.equal(__test.accountFor("some-other-provider"), __test.accountFor("claude-bridge"), "unknown providers must fall back to the default account");
	});

	it("skips an account without configDir", () => {
		__test.configureAccounts({ accounts: { broken: {} } });
		assert.equal(__test.accountFor("claude-bridge-broken"), __test.accountFor("claude-bridge"));
	});

	it("inherits the process config dir for the default account and overrides it for a named account", () => {
		const previous = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = "/tmp/default-claude";
		try {
			__test.configureAccounts({ accounts: { work: WORK } });
			assert.equal(__test.childEnvFor(__test.accountFor("claude-bridge")).CLAUDE_CONFIG_DIR, "/tmp/default-claude");
			assert.equal(__test.childEnvFor(__test.accountFor("claude-bridge-work")).CLAUDE_CONFIG_DIR, join(homedir(), ".claude-work"));
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previous;
		}
	});
});

describe("provider registration per account", () => {
	it("registers one provider per account, named after the config key", () => {
		assert.deepEqual(registered.map(({ id, config }) => [id, config.name]), [
			["claude-bridge-personal", "Claude Code (personal)"],
			["claude-bridge-work", "Claude Code (work)"],
		]);
		assert.ok(registered.every(({ config }) => config.streamSimple && config.models.length > 0));
	});
});

describe("sessions across accounts", () => {
	const root = process.env.CLAUDE_CONFIG_DIR;
	const providerConfig = registered[0].config;
	// pi stamps each model with the provider it was registered under.
	const onDefault = { ...providerConfig.models[0], provider: "claude-bridge-personal" };
	const onWork = { ...providerConfig.models[0], provider: "claude-bridge-work" };
	const user = (content) => ({ role: "user", content, timestamp: 1 });
	const call = (model, messages) => providerConfig.streamSimple(model, { messages }, { sessionId: "accounts-session" }).result();
	const transcript = (call) => readFileSync(getSessionPath(call.sessionId, call.cwd, call.dir), "utf8");
	let calls;

	beforeEach(() => {
		__test.resetSharedSession();
		__test.activeQueryContexts.clear();
		__test.configureAccounts(ACCOUNTS);
		calls = [];
		// A scripted SDK that writes its live records where the child was told to.
		__test.setQuery(({ prompt, options }) => {
			const sessionId = options.sessionId ?? options.resume;
			const dir = options.env.CLAUDE_CONFIG_DIR;
			calls.push({ resume: options.resume, sessionId, dir, cwd: options.cwd });
			const path = getSessionPath(sessionId, options.cwd, dir);
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
				const content = [{ type: "text", text: "answer" }];
				const value = record("assistant", content);
				yield { type: "assistant", parent_tool_use_id: null, uuid: value.uuid, session_id: sessionId, message: { id: `msg_${calls.length}`, model: onWork.id, content } };
				yield { type: "result", subtype: "success", is_error: false, result: "answer", session_id: sessionId };
			})();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});
	});
	afterEach(() => {
		__test.setQuery(null);
		__test.configureAccounts({});
	});

	it("runs a named account's query in its own config dir and resumes it there", async () => {
		const first = user("first");
		const answer = await call(onWork, [first]);
		assert.equal(calls[0].dir, workDir, "Claude Code is pointed at the account's config dir");
		assert.ok(existsSync(getSessionPath(calls[0].sessionId, calls[0].cwd, workDir)), "and its session file is where the bridge looks for it");

		await call(onWork, [first, answer, user("second")]);
		assert.equal(calls[1].resume, calls[0].sessionId, "the same account continues its own session");
		assert.equal(calls[1].dir, workDir);
	});

	it("imports pi's history for the other account instead of resuming across a provider switch", async () => {
		const first = user("first on work");
		const answer = await call(onWork, [first]);
		const workTranscript = transcript(calls[0]);

		await call(onDefault, [first, answer, user("second on default")]);
		assert.equal(calls[1].dir, root, "the default account keeps the process config dir");
		assert.notEqual(calls[1].resume, calls[0].sessionId, "another account's session is never resumed");
		assert.match(transcript(calls[1]), /first on work/, "the history arrives by import, in the default account's dir");
		assert.equal(transcript(calls[0]), workTranscript, "the work account's session is left as it was");
	});
});

describe("thinking across accounts", () => {
	const thinking = (provider, signature = "sig") => ({
		role: "assistant", provider, timestamp: 1,
		content: [{ type: "thinking", thinking: "hm", thinkingSignature: signature }, { type: "text", text: "answer" }],
	});
	const replayed = (message, providerId) => convertPiMessages([message], undefined, undefined, providerId).anthropicMessages[0].content.some((block) => block.type === "thinking");

	it("replays only the thinking the importing account produced", () => {
		assert.equal(replayed(thinking("claude-bridge-work"), "claude-bridge-work"), true);
		assert.equal(replayed(thinking("claude-bridge"), "claude-bridge-work"), false, "another account's signature is not this one's to hand back");
		assert.equal(replayed(thinking("claude-bridge")), true, "the default account is unchanged");
	});

	it("counts a named account's signed thinking in the message digest, as the default account's is", () => {
		assert.notEqual(digestMessage(thinking("claude-bridge-work", "a")), digestMessage(thinking("claude-bridge-work", "b")));
		assert.equal(digestMessage(thinking("anthropic", "a")), digestMessage(thinking("anthropic", "b")), "other providers' thinking is never replayed, so never compared");
	});
});
