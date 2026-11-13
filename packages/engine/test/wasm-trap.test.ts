import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { capWasmMemory, isOutOfMemory, trapKind } from "../src/wasm-trap.ts";

test("WebAssembly traps, aborts and allocation failures are told apart from ordinary errors", () => {
	assert.equal(trapKind(new WebAssembly.RuntimeError("unreachable")), "trap");
	assert.equal(trapKind(new WebAssembly.RuntimeError("Aborted(native code called abort())")), "abort");
	assert.equal(trapKind(new RangeError("Array buffer allocation failed")), "oom");
	assert.equal(trapKind(new RangeError("WebAssembly.Memory.grow(): Maximum memory size exceeded")), null);
	assert.equal(trapKind(new RangeError("Maximum call stack size exceeded")), "trap");
	assert.equal(trapKind(new RangeError("Invalid array length")), null);
	assert.equal(trapKind(new TypeError("x is undefined")), null);
	assert.equal(trapKind("unreachable"), null);
});

test("a real trap from a wasm module is recognised", async () => {
	// (module (func (export "boom") unreachable))
	const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 98, 111, 111, 109, 0, 0, 10, 5, 1, 3, 0, 0, 11]);
	const { instance } = await WebAssembly.instantiate(bytes);
	assert.throws(() => (instance.exports.boom as () => void)(), (err) => trapKind(err) === "trap");
});

test("out-of-memory boot failures are recognised in every browser's wording", () => {
	assert.ok(isOutOfMemory(new RangeError("WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance")));
	assert.ok(isOutOfMemory("out of memory"));
	assert.ok(isOutOfMemory(new RangeError("Out of memory")));
	assert.ok(!isOutOfMemory(new TypeError("NetworkError when attempting to fetch resource.")));
	assert.ok(!isOutOfMemory(new Error("HTTP 404")));
});

/** [initial, maximum] pages of a module's memory section */
function memoryLimits(bytes: Uint8Array): [number, number | null] {
	let p = 8;
	const leb = () => {
		let v = 0;
		let s = 0;
		let b: number;
		do {
			b = bytes[p++]!;
			v += (b & 0x7f) * 2 ** s;
			s += 7;
		} while (b & 0x80);
		return v;
	};
	for (;;) {
		const id = bytes[p++]!;
		const size = leb();
		const end = p + size;
		if (id === 5) {
			leb();
			const flags = bytes[p++]!;
			const initial = leb();
			return [initial, flags & 1 ? leb() : null];
		}
		p = end;
	}
}

test("PDFium's memory ceiling can be lowered without recompiling the glue", async () => {
	const wasm = new Uint8Array(readFileSync(new URL("../src/pdfium/pdfium.wasm", import.meta.url)));
	const [initial, max] = memoryLimits(wasm);
	assert.equal(max, 32768);
	const capped = capWasmMemory(wasm, 16384);
	assert.deepEqual(memoryLimits(capped), [initial, 16384]);
	assert.equal(capped.length, wasm.length);
	assert.ok(WebAssembly.validate(capped));
	await WebAssembly.compile(capped);
	assert.deepEqual(memoryLimits(capWasmMemory(wasm, 1)), [initial, initial], "never below the initial size");
	assert.equal(capWasmMemory(wasm, 40000), wasm, "a higher cap changes nothing");
	assert.deepEqual(memoryLimits(wasm), [initial, 32768], "the input is untouched");
});
