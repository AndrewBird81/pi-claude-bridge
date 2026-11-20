/**
 * Narration: Claude's mid-turn status updates for the user. The API sends them as
 * `thinking` blocks whose signature carries the label "narration" (src/narration.ts).
 * The bridge shows them to pi as text and replays them to Claude as the signed
 * thinking block they arrived as.
 *
 * Built from the recorded single-tool stream. Live Opus 5.5 recordings did not
 * reliably produce a narration block, so the stream's first thinking signature is
 * relabelled "narration" in place: same protobuf, only the label field changes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QueryContext } from "../src/query-state.js";
import { convertPiMessages } from "../src/convert.js";
import { digestMessage } from "../src/message-digests.js";
import { decodeNarrationTextSignature, isNarrationSignature } from "../src/narration.js";

const { __test } = await import("../src/index.js");

const model = {
	api: "anthropic-messages", provider: "claude-bridge", id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

// --- Minimal protobuf rewrite, to relabel a real signature ---

function varint(n) {
	const out = [];
	while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
	out.push(n);
	return Buffer.from(out);
}

/** Top-level entries of a protobuf message, keeping each one's raw bytes. */
function entries(buf) {
	const list = [];
	let i = 0;
	const read = () => { let v = 0, s = 0, b; do { b = buf[i++]; v += (b & 127) * 2 ** s; s += 7; } while (b & 128); return v; };
	while (i < buf.length) {
		const start = i;
		const key = read();
		const wire = key & 7;
		let payload;
		if (wire === 0) read();
		else if (wire === 1) i += 8;
		else if (wire === 5) i += 4;
		else if (wire === 2) { const n = read(); payload = buf.subarray(i, i + n); i += n; }
		else throw new Error(`wire type ${wire}`);
		list.push({ field: Math.floor(key / 8), key, raw: buf.subarray(start, i), payload });
	}
	return list;
}

/** Replace the length-delimited `field` of `buf` with what `edit` returns. */
function rewrite(buf, field, edit) {
	return Buffer.concat(entries(buf).map((e) => e.field === field && e.payload
		? (() => { const p = edit(e.payload); return Buffer.concat([varint(e.key), varint(p.length), p]); })()
		: e.raw));
}

function relabel(signature, label) {
	const bytes = Buffer.from(signature, "base64");
	return rewrite(bytes, 2, (inner) => rewrite(inner, 1, (meta) => rewrite(meta, 8, () => Buffer.from(label)))).toString("base64");
}

// --- Fixture ---

const recorded = readFileSync(new URL("./fixtures/sdk-streams/single-tool.jsonl", import.meta.url), "utf8")
	.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const thinkingSig = recorded.find((m) => m.event?.delta?.type === "signature_delta").event.delta.signature;
const narrationSig = relabel(thinkingSig, "narration");

/** The recorded stream with its first thinking block turned into narration, in both
 *  the streamed signature and the completed `assistant` message that repeats it. */
function narrationStream() {
	const text = JSON.stringify(recorded.slice(0, recorded.findIndex((m) => m.event?.type === "message_stop") + 1));
	return JSON.parse(text.replaceAll(thinkingSig, narrationSig));
}

async function consume(messages) {
	const events = [];
	const c = new QueryContext();
	c.currentPiStream = { push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
	c.resetTurnState(model);
	async function* gen() { yield* messages; }
	await __test.consumeQuery(gen(), new Map([["mcp__custom-tools__read", "read"]]), model, () => false, c);
	return { events, content: c.turnOutput.content };
}

describe("narration signature", () => {
	it("tells a narration label from a thinking label, and rejects junk", () => {
		assert.equal(isNarrationSignature(thinkingSig), false, "recorded thinking stays thinking");
		assert.equal(isNarrationSignature(narrationSig), true);
		assert.equal(isNarrationSignature(relabel(thinkingSig, "narrationX")), false);
		for (const junk of [undefined, "", "not base64 !!", "bmFycmF0aW9u", "////"]) assert.equal(isNarrationSignature(junk), false, String(junk));
	});
});

describe("streaming a turn that holds narration", () => {
	it("shows narration as text carrying its signature, in order before the tool call", async () => {
		const { content, events } = await consume(narrationStream());

		assert.deepEqual(content.map((b) => b.type), ["text", "toolCall"]);
		const [narration] = content;
		assert.match(narration.text, /one\.txt/);
		assert.equal(decodeNarrationTextSignature(narration.textSignature), narrationSig);
		assert.ok(!events.some((e) => e.type.startsWith("thinking_")), "no thinking events for narration");
		const kinds = events.filter((e) => /_(start|end)$/.test(e.type)).map((e) => `${e.type}@${e.contentIndex}`);
		assert.deepEqual(kinds, ["text_start@0", "text_end@0", "toolcall_start@1", "toolcall_end@1"]);
	});

	it("keeps ordinary thinking as thinking", async () => {
		const { content } = await consume(recorded.slice(0, recorded.findIndex((m) => m.event?.type === "message_stop") + 1));

		assert.deepEqual(content.map((b) => b.type), ["thinking", "toolCall"]);
		assert.equal(content[0].thinkingSignature, thinkingSig);
	});

	it("classifies the non-streaming fallback the same way", async () => {
		const assistant = narrationStream().find((m) => m.type === "assistant");
		const { content } = await consume([assistant]);

		assert.equal(content[0].type, "text");
		assert.equal(decodeNarrationTextSignature(content[0].textSignature), narrationSig);
	});
});

describe("replaying narration to Claude", () => {
	const piMessage = async (provider) => {
		const { content } = await consume(narrationStream());
		return { role: "assistant", provider, api: "anthropic-messages", model: "m", timestamp: 1, content };
	};
	const convert = (msg, providerId) => convertPiMessages([msg], undefined, undefined, providerId).anthropicMessages[0].content;

	it("goes back as the signed thinking block it arrived as", async () => {
		const msg = await piMessage("claude-bridge");
		const [first] = convert(msg);
		assert.deepEqual(first, { type: "thinking", thinking: msg.content[0].text, signature: narrationSig });
	});

	it("is plain text to any other account or provider", async () => {
		for (const [provider, importer] of [["claude-bridge", "claude-bridge-work"], ["anthropic", "claude-bridge"]]) {
			const msg = await piMessage(provider);
			assert.deepEqual(convert(msg, importer)[0], { type: "text", text: msg.content[0].text }, `${provider} → ${importer}`);
		}
	});

	it("counts its signature in the message digest", async () => {
		const msg = await piMessage("claude-bridge");
		const plain = { ...msg, content: [{ type: "text", text: msg.content[0].text }, msg.content[1]] };
		assert.notEqual(digestMessage(msg), digestMessage(plain));
		const foreign = { ...msg, provider: "anthropic" };
		assert.equal(digestMessage(foreign), digestMessage({ ...plain, provider: "anthropic" }), "never replayed elsewhere, so never compared");
	});
});
