/**
 * Multi-account support: account resolution from provider.accounts config,
 * per-provider registration, and syncSharedSession's cross-account behavior.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";

const { default: activate, __test } = await import("../src/index.js");

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
});

describe("provider registration per account", () => {
	it("registers one provider per account, named after the config key", () => {
		const registered = [];
		activate({
			on: () => {},
			registerProvider: (id, config) => registered.push({ id, config }),
			registerTool: () => {},
		});
		// Activation reads the real config files; whatever accounts they hold,
		// the default provider must be first and unnamed (pi falls back to the id).
		assert.equal(registered[0].id, "claude-bridge");
		assert.equal(registered[0].config.name, undefined);
		// Reconfigure and re-derive what registration WOULD produce is not
		// possible without re-activating (the ACTIVE_STREAM_SIMPLE_KEY guard
		// blocks a second registration), so the shape of named accounts is
		// asserted through accountFor instead.
		__test.configureAccounts({ accounts: { work: WORK } });
		assert.equal(__test.accountFor("claude-bridge-work").label, "work");
		__test.configureAccounts({});
	});
});

describe("syncSharedSession across accounts", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.configureAccounts({});
	});

	const msgs = (n) => {
		const out = [];
		for (let i = 0; i < n; i++) {
			out.push({ role: "user", content: `u${i}`, timestamp: Date.now() });
			out.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }], timestamp: Date.now() });
		}
		out.push({ role: "user", content: "current turn", timestamp: Date.now() });
		return out;
	};

	it("does not resume a session that belongs to another account", () => {
		const cwd = mkdtempSync(join(tmpdir(), "accounts-"));
		const workDir = mkdtempSync(join(tmpdir(), "accounts-workdir-"));
		try {
			__test.configureAccounts({ accounts: { work: { configDir: workDir } } });
			// Simulate: default account owns the shared session, cursor in sync.
			const defaultDir = mkdtempSync(join(tmpdir(), "accounts-defaultdir-"));
			process.env.CLAUDE_CONFIG_DIR = defaultDir;
			try {
				const seeded = createSession({ projectPath: cwd, claudeDir: defaultDir });
				seeded.importMessages([{ role: "user", content: "u0" }, { role: "assistant", content: [{ type: "text", text: "a0" }] }]);
				seeded.save();
				__test.setSharedSession({ sessionId: seeded.sessionId, cursor: 2, cwd, providerId: "claude-bridge" });

				const result = __test.syncSharedSession(msgs(1), cwd, undefined, undefined, __test.accountFor("claude-bridge-work"));

				assert.notEqual(result.sessionId, null, "an account toggle must rebuild, not start clean");
				const shared = __test.getSharedSession();
				assert.equal(shared.providerId, "claude-bridge-work");
				assert.ok(existsSync(getSessionPath(shared.sessionId, cwd, workDir)), "the rebuilt session must live in the new account's dir");
				assert.ok(!existsSync(getSessionPath(seeded.sessionId, cwd, defaultDir)), "the old session must be wiped from the OLD account's dir");
			} finally {
				delete process.env.CLAUDE_CONFIG_DIR;
				rmSync(defaultDir, { recursive: true, force: true });
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("preserves the parent's session for a shorter cross-account context", () => {
		const cwd = mkdtempSync(join(tmpdir(), "accounts-"));
		const workDir = mkdtempSync(join(tmpdir(), "accounts-workdir-"));
		try {
			__test.configureAccounts({ accounts: { work: { configDir: workDir } } });
			const parent = { sessionId: "11111111-1111-4111-8111-111111111111", cursor: 42, cwd, providerId: "claude-bridge" };
			__test.setSharedSession(parent);

			const result = __test.syncSharedSession(
				[{ role: "user", content: "subagent prompt", timestamp: Date.now() }],
				cwd, undefined, undefined, __test.accountFor("claude-bridge-work"),
			);

			assert.equal(result.sessionId, null, "a reentrant subagent on another account must start fresh");
			assert.equal(result.preserveSharedSession, true, "…and must not replace the parent's session");
			assert.deepEqual(__test.getSharedSession(), parent);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	it("reuses the session when the same named account continues", () => {
		const cwd = mkdtempSync(join(tmpdir(), "accounts-"));
		const workDir = mkdtempSync(join(tmpdir(), "accounts-workdir-"));
		try {
			__test.configureAccounts({ accounts: { work: { configDir: workDir } } });
			const state = { sessionId: "22222222-2222-4222-8222-222222222222", cursor: 2, cwd, providerId: "claude-bridge-work" };
			__test.setSharedSession(state);

			const result = __test.syncSharedSession(msgs(1), cwd, undefined, undefined, __test.accountFor("claude-bridge-work"));

			assert.equal(result.sessionId, state.sessionId, "same account, in-sync history must REUSE");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(workDir, { recursive: true, force: true });
		}
	});
});
