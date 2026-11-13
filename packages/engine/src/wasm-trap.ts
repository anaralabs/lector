// A PDFium instance that trapped or ran out of memory is corrupt: nothing it holds can be trusted.

export type TrapKind = "trap" | "abort" | "oom";

/** What kind of WebAssembly failure `err` is, or null for an ordinary error. */
export function trapKind(err: unknown): TrapKind | null {
	const RuntimeError = (globalThis as { WebAssembly?: typeof WebAssembly }).WebAssembly?.RuntimeError;
	if (RuntimeError && err instanceof RuntimeError) return err.message.startsWith("Aborted(") ? "abort" : "trap";
	if (!(err instanceof RangeError)) return null;
	if (/allocation failed|out of memory|could not allocate/i.test(err.message)) return "oom";
	if (/call stack/i.test(err.message)) return "trap";
	return null;
}

/** The browser could not allocate memory (a wasm memory reservation, an ArrayBuffer): Firefox can throw the bare string. */
export function isOutOfMemory(err: unknown): boolean {
	return trapKind(err) === "oom" || /out of memory|could not allocate|allocation failed/i.test(String((err as Error)?.message ?? err));
}

/**
 * `bytes` with its memory's maximum lowered to `pages` (never below its
 * initial size), rewritten in place: the new limit is padded to the old
 * limit's LEB128 length. Unchanged when the memory has no maximum or a lower one.
 */
export function capWasmMemory(bytes: Uint8Array<ArrayBuffer>, pages: number): Uint8Array<ArrayBuffer> {
	let p = 8;
	const leb = () => {
		let value = 0;
		let shift = 0;
		let byte: number;
		do {
			byte = bytes[p++]!;
			value += (byte & 0x7f) * 2 ** shift;
			shift += 7;
		} while (byte & 0x80);
		return value;
	};
	while (p < bytes.length) {
		const id = bytes[p++]!;
		const size = leb();
		const end = p + size;
		if (id === 5 && leb() > 0) {
			const flags = bytes[p++]!;
			const initial = leb();
			if (!(flags & 1)) return bytes;
			const at = p;
			const max = leb();
			const cap = Math.max(initial, pages);
			if (cap >= max) return bytes;
			const out = bytes.slice();
			const len = p - at;
			for (let i = 0, v = cap; i < len; i++, v = Math.floor(v / 128)) out[at + i] = (v % 128) | (i < len - 1 ? 0x80 : 0);
			return out;
		}
		p = end;
	}
	return bytes;
}
