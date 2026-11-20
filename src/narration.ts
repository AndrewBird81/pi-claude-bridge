// Narration: Claude's mid-turn status updates for the user.
//
// The API sends them as ordinary `thinking` blocks. The only thing that sets one
// apart is a label inside its signature — "narration" instead of "thinking". No
// documented field carries it (not sdk.d.ts, not @anthropic-ai/sdk), so this
// mirrors Claude Code's own classifier (isNarrationTaggedBlock, CC 2.1.257): the
// signature is a base64 protobuf, and the label is the string at field 2 → 1 → 8.
// Anything that does not decode that way is treated as thinking, as before.

const NARRATION_LABEL = "narration";

/** Length-delimited fields of one protobuf message, or null if it does not parse. */
function protoFields(buf: Uint8Array): Map<number, Uint8Array> | null {
	const fields = new Map<number, Uint8Array>();
	let i = 0;
	const varint = (): number => {
		let value = 0, shift = 0, byte: number;
		do {
			if (i >= buf.length || shift > 49) throw new Error("bad varint");
			byte = buf[i++];
			value += (byte & 0x7f) * 2 ** shift;
			shift += 7;
		} while (byte & 0x80);
		return value;
	};
	try {
		while (i < buf.length) {
			const key = varint();
			const wireType = key & 7;
			if (wireType === 0) varint();
			else if (wireType === 1) i += 8;
			else if (wireType === 5) i += 4;
			else if (wireType === 2) {
				const len = varint();
				if (i + len > buf.length) return null;
				const field = Math.floor(key / 8);
				if (!fields.has(field)) fields.set(field, buf.subarray(i, i + len));
				i += len;
			} else return null;
			if (i > buf.length) return null;
		}
	} catch {
		return null;
	}
	return fields;
}

/** True when a thinking block's signature labels it as narration. */
export function isNarrationSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	let bytes: Uint8Array;
	try {
		bytes = Buffer.from(signature, "base64");
	} catch {
		return false;
	}
	const inner = protoFields(bytes)?.get(2);
	const meta = inner && protoFields(inner)?.get(1);
	const label = meta && protoFields(meta)?.get(8);
	return !!label && Buffer.from(label).toString("utf8") === NARRATION_LABEL;
}

// A narration block is shown to the user as a pi `text` block, but must go back
// to Claude as the signed thinking block it arrived as. The signature rides in
// `textSignature`, which pi-ai's own Anthropic provider ignores.
const NARRATION_SIGNATURE_VERSION = "cc-narration";

export function encodeNarrationTextSignature(signature: string): string {
	return JSON.stringify({ v: NARRATION_SIGNATURE_VERSION, signature });
}

/** The thinking signature a pi text block carries, if it is narration we recorded. */
export function decodeNarrationTextSignature(textSignature: string | undefined): string | undefined {
	if (!textSignature?.startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(textSignature);
		return parsed?.v === NARRATION_SIGNATURE_VERSION && typeof parsed.signature === "string" && parsed.signature
			? parsed.signature
			: undefined;
	} catch {
		return undefined;
	}
}
