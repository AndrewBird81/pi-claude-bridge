/**
 * Fork-only: Claude Code-ahead model fallbacks (FORK.md, src/models.ts).
 * Pins: a fallback reaches the picker and its family shortcut, pi-ai's entry
 * replaces it once the catalog lists the same id, and haiku-5-5 runs at 1M.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyLongContext, buildModels, CLAUDE_CODE_MODEL_FALLBACKS, claudeCodeModelId, resolveModel } from "../src/models.js";
import { getModels } from "@earendil-works/pi-ai/compat";

const PRO = { plan: "pro", longContextExtraUsage: false };
const MAX = { plan: "max", longContextExtraUsage: false };

const models = buildModels([...getModels("anthropic"), ...CLAUDE_CODE_MODEL_FALLBACKS]);
const find = (list, id) => list.find((m) => m.id === id);

describe("Claude Code-ahead fallbacks", () => {
	it("lists claude-haiku-5-5 with xhigh and max, and haiku resolves to it", () => {
		assert.deepEqual(find(models, "claude-haiku-5-5")?.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
		assert.equal(resolveModel(models, "haiku")?.id, "claude-haiku-5-5");
		assert.ok(find(models, "claude-haiku-4-5"), "haiku-4-5 stays selectable");
	});

	it("prefers pi-ai's entry once the catalog lists a fallback id", () => {
		const merged = buildModels([{ id: "claude-haiku-5-5", name: "Catalog name" }, ...CLAUDE_CODE_MODEL_FALLBACKS]);
		assert.equal(merged.filter((m) => m.id === "claude-haiku-5-5").length, 1);
		assert.equal(find(merged, "claude-haiku-5-5").name, "Catalog name");
	});

	it("runs claude-haiku-5-5 at 1M through the [1m] id on every plan", () => {
		for (const plan of [PRO, MAX]) {
			const registered = find(applyLongContext(models, plan), "claude-haiku-5-5");
			assert.equal(registered.contextWindow, 1000000);
			assert.equal(registered.name, "Claude Haiku 5.5 1M");
			assert.equal(claudeCodeModelId(registered, plan), "claude-haiku-5-5[1m]");
		}
	});
});
