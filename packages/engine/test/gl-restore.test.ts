import assert from "node:assert/strict";
import { test } from "node:test";
import { GLCompositor } from "../src/gl.ts";

function fakeCanvas(state: { compiles: boolean; log: string | null }) {
	const gl = new Proxy(
		{
			getShaderParameter: () => state.compiles,
			getProgramParameter: () => true,
			getShaderInfoLog: () => state.log,
			isContextLost: () => false,
			createVertexArray: () => ({}),
			createBuffer: () => ({}),
			createShader: () => ({}),
			createProgram: () => ({}),
			getUniformLocation: () => ({}),
			getAttribLocation: () => 0,
		} as Record<string, unknown>,
		{ get: (t, k) => (k in t ? t[k as string] : () => {}) },
	);
	return Object.assign(new EventTarget(), {
		width: 0,
		height: 0,
		getContext: () => gl,
	}) as unknown as OffscreenCanvas;
}

test("a restored context whose shaders fail to compile reports another loss instead of throwing", () => {
	const state = { compiles: true, log: "" as string | null };
	const canvas = fakeCanvas(state);
	const gl = new GLCompositor(canvas);
	const causes: unknown[] = [];
	let restored = 0;
	gl.onLost = (cause) => causes.push(cause);
	gl.onRestored = () => restored++;

	canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
	state.compiles = false;
	assert.doesNotThrow(() =>
		canvas.dispatchEvent(new Event("webglcontextrestored")),
	);

	assert.equal(restored, 0);
	assert.equal(gl.lost, true);
	assert.equal(causes.length, 2);
	assert.equal(causes[0], undefined);
	assert.equal(
		(causes[1] as Error).message,
		"lector-engine: shader failed to compile",
	);
	gl.dispose();
});

test("a restored context that rebuilds reports restored", () => {
	const canvas = fakeCanvas({ compiles: true, log: null });
	const gl = new GLCompositor(canvas);
	let restored = 0;
	gl.onRestored = () => restored++;
	canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
	canvas.dispatchEvent(new Event("webglcontextrestored"));
	assert.equal(restored, 1);
	assert.equal(gl.lost, false);
	gl.dispose();
});

test("shader errors carry the driver's info log when it has one", () => {
	assert.throws(
		() =>
			new GLCompositor(
				fakeCanvas({ compiles: false, log: "ERROR: 0:3: syntax error\n" }),
			),
		{
			message:
				"lector-engine: shader failed to compile: ERROR: 0:3: syntax error",
		},
	);
});
