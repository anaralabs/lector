import assert from "node:assert/strict";
import { test } from "node:test";
import { open2d, retryCompositor } from "../src/context-loss.ts";
import type { ViewerCore } from "../src/core.ts";
import { type CoreInput, replayInput } from "../src/core-input.ts";
import { GLCompositor } from "../src/gl.ts";

type Canvas = HTMLCanvasElement | OffscreenCanvas;

/** A WebGL2 context whose shaders never compile (a broken driver), without being lost. */
const brokenGl = () =>
	new Proxy({} as Record<string, unknown>, {
		get: (_t, key) => {
			if (key === "isContextLost") return () => false;
			if (key === "getShaderParameter") return () => false;
			if (key === "getShaderInfoLog") return () => "driver bug";
			return () => ({});
		},
	});

/** A canvas that, like a browser's, keeps the first context kind it handed out and refuses every other kind. */
function fakeCanvas(webgl2: "none" | "broken") {
	let bound: string | null = null;
	const asked: string[] = [];
	const canvas = {
		addEventListener() {},
		getContext(kind: string) {
			asked.push(kind);
			if (bound && bound !== kind) return null;
			if (kind === "webgl2" && webgl2 === "none") return null;
			bound = kind;
			return kind === "webgl2" ? brokenGl() : { isContextLost: () => false };
		},
	};
	return { canvas: canvas as unknown as Canvas, asked };
}

test("WebGL2 that fails to build keeps its canvas: 2D there gets null, a fresh canvas gets 2D", () => {
	const { canvas, asked } = fakeCanvas("broken");
	assert.throws(() => new GLCompositor(canvas), /shader failed to compile: driver bug/);
	assert.throws(() => open2d(canvas, true), /Canvas 2D is not available \(getContext returned null\)/);
	assert.deepEqual(asked, ["webgl2", "2d"]);
	assert.equal(open2d(fakeCanvas("broken").canvas, true).cpu, true);
});

test("a canvas without WebGL2 still takes a 2D context", () => {
	const { canvas } = fakeCanvas("none");
	assert.throws(() => new GLCompositor(canvas), /WebGL2 is not available/);
	assert.equal(open2d(canvas, true).cpu, true);
});

test("a compositor that cannot start is retried in 2D unless the host pinned the one that failed", () => {
	assert.equal(retryCompositor("webgl2", true), "canvas2d");
	assert.equal(retryCompositor("canvas2d", true), "canvas2d");
	assert.equal(retryCompositor("canvas2d", false), "canvas2d");
	assert.equal(retryCompositor("webgl2", false), null);
});

test("messages the worker never ran reach the main-thread core in order", () => {
	const calls: string[] = [];
	const core = {
		handle: (m: { type: string }) => calls.push(`input:${m.type}`),
		command: (c: { type: string }) => calls.push(`command:${c.type}`),
		setHidden: (h: boolean) => calls.push(`hidden:${h}`),
		swapCanvas: () => calls.push("canvas"),
		canvasFailed: (r: string) => calls.push(`canvas-failed:${r}`),
	} as unknown as ViewerCore;
	const sent = [
		{ t: "hidden", hidden: false },
		{ t: "input", msg: { type: "resize" } },
		{ t: "command", cmd: { type: "zoom" } },
		{ t: "canvas", canvas: {} },
		{ t: "canvas-failed", reason: "x" },
	] as unknown as CoreInput[];
	for (const m of sent) replayInput(core, m);
	assert.deepEqual(calls, ["hidden:false", "input:resize", "command:zoom", "canvas", "canvas-failed:x"]);
});
