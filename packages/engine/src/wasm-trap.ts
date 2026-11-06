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
