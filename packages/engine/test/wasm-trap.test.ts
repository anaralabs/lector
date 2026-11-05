import assert from "node:assert/strict";
import { test } from "node:test";
import { trapKind } from "../src/wasm-trap.ts";

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
