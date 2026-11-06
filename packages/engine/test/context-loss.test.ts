import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextRecovery, open2d } from "../src/context-loss.ts";
import type { Compositor } from "../src/gl.ts";

type Settings = { willReadFrequently?: boolean };
type Canvas = HTMLCanvasElement | OffscreenCanvas;

/** A canvas whose 2D context is decided per call: a context, null, a lost context, or a throw. */
function fakeCanvas(answer: (s: Settings) => "ok" | "null" | "lost" | "throw") {
	const asked: Settings[] = [];
	const canvas = {
		addEventListener() {},
		getContext(_kind: string, s: Settings) {
			asked.push(s);
			const a = answer(s);
			if (a === "throw") throw new Error("blocked by an extension");
			if (a === "null") return null;
			return { isContextLost: () => a === "lost", settings: s };
		},
	};
	return { canvas: canvas as unknown as Canvas, asked };
}

test("2D: a refused GPU context falls back to a CPU-backed one", () => {
	for (const refusal of ["null", "lost", "throw"] as const) {
		const { canvas, asked } = fakeCanvas((s) => (s.willReadFrequently ? "ok" : refusal));
		assert.equal(open2d(canvas, false).cpu, true, refusal);
		assert.equal(asked.length, 2);
	}
	const { canvas, asked } = fakeCanvas(() => "ok");
	assert.equal(open2d(canvas, false).cpu, false);
	assert.deepEqual(asked, [{ alpha: false, desynchronized: true }]);
});

test("2D: a CPU-backed request never asks for the GPU", () => {
	const { canvas, asked } = fakeCanvas(() => "ok");
	assert.equal(open2d(canvas, true).cpu, true);
	assert.deepEqual(asked, [{ alpha: false, willReadFrequently: true }]);
});

test("2D: no context at all says why", () => {
	assert.throws(() => open2d(fakeCanvas(() => "throw").canvas, false), /Canvas 2D is not available \(blocked by an extension\)/);
	assert.throws(() => open2d(fakeCanvas(() => "null").canvas, true), /getContext returned null/);
});

class FakeTimers {
	private queue: { at: number; fn: () => void; id: number }[] = [];
	private id = 0;
	now = 0;
	set = (fn: () => void, ms: number) => {
		this.queue.push({ at: this.now + ms, fn, id: ++this.id });
		return this.id;
	};
	clear = (id: unknown) => {
		this.queue = this.queue.filter((t) => t.id !== id);
	};
	advance(ms: number) {
		const end = this.now + ms;
		for (;;) {
			const next = this.queue.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!next) break;
			this.queue = this.queue.filter((t) => t !== next);
			this.now = next.at;
			next.fn();
		}
		this.now = end;
	}
}

function fakeCompositor(kind: "webgl2" | "canvas2d", lost = false) {
	return { kind, lost, onLost: () => {}, onRestored: () => {} } as unknown as Compositor;
}

function setup() {
	const timers = new FakeTimers();
	const events: { type: string; code?: string; message?: string }[] = [];
	const recovery = new ContextRecovery((e) => events.push(e), timers);
	const types = () => events.map((e) => (e.type === "error" ? `error:${e.code}` : e.type));
	return { timers, events, recovery, types };
}

test("a lost WebGL context the browser does not restore asks for a canvas after the wait", () => {
	const { timers, recovery, types } = setup();
	const gl = fakeCompositor("webgl2");
	recovery.watch(gl, () => {});
	gl.onLost();
	assert.deepEqual(types(), ["error:gpu"]);
	timers.advance(1499);
	assert.deepEqual(types(), ["error:gpu"]);
	timers.advance(1);
	assert.deepEqual(types(), ["error:gpu", "need-canvas"]);
});

test("a restore within the wait keeps WebGL", () => {
	const { timers, recovery, types } = setup();
	const gl = fakeCompositor("webgl2");
	let restored = 0;
	recovery.watch(gl, () => restored++);
	gl.onLost();
	timers.advance(800);
	gl.onRestored();
	timers.advance(5000);
	assert.equal(restored, 1);
	assert.deepEqual(types(), ["error:gpu"]);
});

test("a second loss moves to 2D at once, with one request", () => {
	const { timers, recovery, types } = setup();
	const gl = fakeCompositor("webgl2");
	recovery.watch(gl, () => {});
	gl.onLost();
	timers.advance(500);
	gl.onRestored();
	gl.onLost();
	timers.advance(0);
	assert.deepEqual(types(), ["error:gpu", "error:gpu", "need-canvas"]);
	timers.advance(5000);
	assert.equal(types().filter((t) => t === "need-canvas").length, 1);
});

test("losses in a row during the wait (no restore between) still ask once", () => {
	const { timers, recovery, types } = setup();
	const gl = fakeCompositor("webgl2");
	recovery.watch(gl, () => {});
	gl.onLost();
	timers.advance(700);
	gl.onLost();
	timers.advance(5000);
	assert.equal(types().filter((t) => t === "need-canvas").length, 1);
});

test("a context handed out already lost asks for a canvas right away", () => {
	const { timers, recovery, types } = setup();
	recovery.watch(fakeCompositor("webgl2", true), () => {});
	timers.advance(0);
	assert.deepEqual(types(), ["need-canvas"]);
});

test("the loss event that follows a context lost at creation does not delay the request", () => {
	const { timers, recovery, types } = setup();
	const gl = fakeCompositor("webgl2", true);
	recovery.watch(gl, () => {});
	gl.onLost();
	timers.advance(0);
	assert.deepEqual(types(), ["error:gpu", "need-canvas"]);
});

test("a lost 2D context is replaced like a lost WebGL one", () => {
	const { timers, recovery, types, events } = setup();
	const ctx2d = fakeCompositor("canvas2d");
	recovery.watch(ctx2d, () => {});
	ctx2d.onLost();
	timers.advance(1500);
	assert.deepEqual(types(), ["error:gpu", "need-canvas"]);
	assert.match(events[0]?.message ?? "", /the Canvas 2D context was lost/);
});

test("a fresh canvas that cannot draw asks for one more, then errors with code compositor", () => {
	const { timers, recovery, types, events } = setup();
	const gl = fakeCompositor("webgl2");
	recovery.watch(gl, () => {});
	gl.onLost();
	timers.advance(1500);
	const broken = () => {
		throw new Error("Canvas 2D is not available (getContext returned null)");
	};
	assert.equal(recovery.swap({} as Canvas, broken), null);
	assert.deepEqual(types(), ["error:gpu", "need-canvas", "need-canvas"]);
	assert.equal(recovery.swap({} as Canvas, broken), null);
	assert.deepEqual(types(), ["error:gpu", "need-canvas", "need-canvas", "error:compositor"]);
	assert.equal(events.at(-1)?.message, "lector-engine: Canvas 2D switch failed: Canvas 2D is not available (getContext returned null)");
});

test("the retry canvas works: the switch completes", () => {
	const { recovery } = setup();
	let calls = 0;
	const next = fakeCompositor("canvas2d");
	const make = () => {
		if (calls++ === 0) throw new Error("lost");
		return next;
	};
	assert.equal(recovery.swap({} as Canvas, make), null);
	assert.equal(recovery.swap({} as Canvas, make), next);
});

test("a host that cannot make a canvas errors with code compositor, once", () => {
	const { recovery, types } = setup();
	recovery.fail("transferControlToOffscreen threw");
	recovery.fail("again");
	assert.deepEqual(types(), ["error:compositor"]);
});

test("every loss ends in a compositor or a typed error", () => {
	for (let failures = 0; failures <= 3; failures++) {
		const { timers, recovery, types } = setup();
		const gl = fakeCompositor("webgl2");
		recovery.watch(gl, () => {});
		gl.onLost();
		let left = failures;
		let switched: Compositor | null = null;
		for (let round = 0; round < 10 && !switched; round++) {
			timers.advance(2000);
			if (types().at(-1) !== "need-canvas") break;
			switched = recovery.swap({} as Canvas, () => {
				if (left-- > 0) throw new Error("no context");
				return fakeCompositor("canvas2d");
			});
		}
		assert.ok(switched || types().at(-1) === "error:compositor", `${failures}: ${types()}`);
	}
});

test("a GPU that keeps dropping fresh canvases is given up on", () => {
	const { timers, recovery, types } = setup();
	let current = fakeCompositor("webgl2");
	recovery.watch(current, () => {});
	for (let i = 0; i < 4; i++) {
		current.onLost();
		timers.advance(2000);
		if (types().at(-1) !== "need-canvas") break;
		current = recovery.swap({} as Canvas, () => fakeCompositor("canvas2d"))!;
		recovery.watch(current, () => {});
	}
	assert.equal(types().at(-1), "error:compositor");
	assert.equal(types().filter((t) => t === "need-canvas").length, 3);
});

test("a disposed core stops asking", () => {
	const { timers, recovery, types } = setup();
	const gl = fakeCompositor("webgl2");
	recovery.watch(gl, () => {});
	gl.onLost();
	recovery.dispose();
	timers.advance(5000);
	assert.deepEqual(types(), ["error:gpu"]);
});
