import assert from "node:assert/strict";
import { test } from "node:test";
import { type CamState, easePath, fromState, glidePath, kick, matchVelocity, type Path, progress, toState, zoomPath } from "../src/flight-path.ts";

const VW = 1280;
const VH = 860;
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b)), `${a} != ${b}`);
const same = (a: CamState, b: CamState, eps = 1e-6) => {
	close(a.cx, b.cx, eps);
	close(a.cy, b.cy, eps);
	close(a.lz, b.lz, eps);
};
// letter pages at fit-width (~1.5x): a viewport is ~0.7 pages tall
const zoom = 1.5;
const at = (page: number, z = zoom): CamState => ({ cx: 0, cy: page * 804 + 400, lz: Math.log(z) });
const cap = (a: CamState, b: CamState) => Math.max(VH / Math.exp(a.lz), VH / Math.exp(b.lz)) * 5;

test("progress: starts at v0, lands at rest, never overshoots", () => {
	for (const v0 of [0, 0.5, 1.5, 3]) {
		assert.equal(progress(0, v0), 0);
		assert.equal(progress(1, v0), 1);
		close((progress(1e-6, v0) - 0) / 1e-6, v0, 1e-3);
		close((1 - progress(1 - 1e-6, v0)) / 1e-6, 0, 1e-3);
		let prev = 0;
		for (let t = 0; t <= 1; t += 0.01) {
			const p = progress(t, v0);
			assert.ok(p >= prev - 1e-12 && p <= 1 + 1e-12, `v0=${v0} t=${t} p=${p}`);
			prev = p;
		}
	}
	for (let t = 0; t <= 1; t += 0.1) close(progress(t, 3), 1 - (1 - t) ** 3);
	assert.equal(progress(0.5, 9), progress(0.5, 3));
});

test("kick: leaves with slope 1 and comes back to rest", () => {
	assert.equal(kick(0), 0);
	assert.equal(kick(1), 0);
	close(kick(1e-6) / 1e-6, 1, 1e-4);
	close(kick(1 - 1e-6) / 1e-6, 0, 1e-4);
});

test("state round-trips through the camera", () => {
	const c = { x: -300, y: 4210, zoom: 1.7 };
	const back = fromState(toState(c, VW, VH), VW, VH);
	close(back.x, c.x);
	close(back.y, c.y);
	close(back.zoom, c.zoom);
});

test("ease path: exact endpoints and the old duration range", () => {
	const a = at(0);
	const b = at(2, 2);
	const p = easePath(a, b, VH);
	same(p.at(0), a);
	same(p.at(1), b);
	assert.ok(p.dur >= 220 && p.dur <= 600);
	assert.equal(p.skip, 0);
});

test("glide: one straight move, duration bounded however far", () => {
	for (const pages of [1, 3, 20, 130, 2000]) {
		const a = at(0);
		const b = at(pages);
		const p = glidePath(a, b, VH);
		same(p.at(0), a);
		same(p.at(1), b);
		close(p.at(0.5).cy, (a.cy + b.cy) / 2);
		close(p.at(0.37).lz, a.lz);
		assert.ok(p.dur >= 240 && p.dur <= 600, `${pages} pages: ${p.dur}ms`);
		assert.equal(p.skip, 0);
	}
	assert.ok(glidePath(at(0), at(130), VH).dur > glidePath(at(0), at(2), VH).dur);
	// starting from rest, the speed peaks mid-flight and is zero at both ends
	const speed = (t: number) => (progress(t + 1e-4, 0) - progress(t - 1e-4, 0)) / 2e-4;
	close(progress(1e-6, 0) / 1e-6, 0, 1e-3);
	assert.ok(speed(0.5) > speed(0.25) && speed(0.5) > speed(0.75));
});

const samples = (p: Path, n = 400) => Array.from({ length: n + 1 }, (_, i) => p.at(i / n));

test("zoom path: exact endpoints, pulls back, and stays within the cap", () => {
	for (const [from, to] of [
		[3, 40],
		[40, 3],
		[0, 120],
		[10, 13],
	] as const) {
		const a = at(from);
		const b = at(to);
		const capW = cap(a, b);
		const p = zoomPath(a, b, VH, { capW });
		same(p.at(0), a);
		same(p.at(1), b);
		const widest = Math.max(...samples(p).map((s) => VH / Math.exp(s.lz)));
		assert.ok(widest > VH / zoom, "pulls back");
		assert.ok(widest <= capW * 1.001, `peak ${widest} > cap ${capW}`);
		close(p.minZoom, VH / widest, 1e-2);
		assert.ok(p.dur >= 300 && p.dur <= 560, `dur ${p.dur}`);
	}
});

test("zoom path: monotonic travel, one cut at most (at the widest point)", () => {
	const a = at(2);
	const b = at(100);
	const p = zoomPath(a, b, VH, { capW: cap(a, b) });
	assert.ok(p.skip > 0, "a 98-page jump skips part of the gap");
	const s = samples(p, 2000);
	let jumps = 0;
	for (let i = 1; i < s.length; i++) {
		const d = s[i]!.cy - s[i - 1]!.cy;
		assert.ok(d >= -1e-9, "never moves backwards");
		if (d > p.skip * 0.5) {
			jumps++;
			const w = VH / Math.exp(s[i]!.lz);
			const widest = Math.max(...s.map((x) => VH / Math.exp(x.lz)));
			assert.ok(w > widest * 0.99, "the cut happens fully pulled back");
			assert.ok((i - 1) / 2000 < p.cutAt && i / 2000 >= p.cutAt, "cutAt marks the skip");
		}
	}
	assert.equal(jumps, 1);
	const near = zoomPath(at(3), at(6), VH, { capW: cap(at(3), at(6)) });
	assert.equal(near.skip, 0, "a 3-page jump flies the whole way");
	assert.equal(near.cutAt, Infinity);
});

test("zoom path: the skip snaps to whole pages", () => {
	const a = at(2);
	const b = at(100);
	const p = zoomPath(a, b, VH, { capW: cap(a, b), snapSkip: (skip) => Math.round(skip / 804) * 804 });
	close(p.skip % 804, 0, 1e-9);
	same(p.at(1), b);
});

test("zoom path: zoom-only and opposite directions", () => {
	const a = at(5, 1);
	const b = at(5, 4);
	const p = zoomPath(a, b, VH, { capW: VH });
	same(p.at(0), a);
	same(p.at(1), b);
	const up = zoomPath(at(60), at(1), VH, { capW: cap(at(60), at(1)) });
	same(up.at(1), at(1));
});

/** Camera state of a (path, v0, rest) flight `ms` after it started. */
const fly = (p: Path, v0: number, rest: CamState, ms: number): CamState => {
	const t = Math.max(0, Math.min(1, ms / p.dur));
	const s = p.at(progress(t, v0));
	const k = kick(t) * p.dur;
	return { cx: s.cx + rest.cx * k, cy: s.cy + rest.cy * k, lz: s.lz + rest.lz * k };
};
const velocity = (f: (ms: number) => CamState, ms: number): CamState => {
	const a = f(ms - 0.01);
	const b = f(ms + 0.01);
	return { cx: (b.cx - a.cx) / 0.02, cy: (b.cy - a.cy) / 0.02, lz: (b.lz - a.lz) / 0.02 };
};

test("retarget keeps position and velocity continuous", () => {
	for (const [first, second] of [
		[easePath(at(0), at(2), VH), (s: CamState) => easePath(s, at(1), VH)],
		[zoomPath(at(0), at(60), VH, { capW: cap(at(0), at(60)) }), (s: CamState) => zoomPath(s, at(5), VH, { capW: cap(s, at(5)) })],
		[easePath(at(0), at(2), VH), (s: CamState) => zoomPath(s, at(40), VH, { capW: cap(s, at(40)) })],
		[glidePath(at(0), at(120), VH), (s: CamState) => glidePath(s, at(10), VH)],
		[glidePath(at(0), at(120), VH), (s: CamState) => glidePath(s, at(125), VH)],
	] as const) {
		const v0a = first.kind === "ease" ? 3 : first.kind === "glide" ? 0 : 1.5;
		const zero = { cx: 0, cy: 0, lz: 0 };
		const ms = first.dur * 0.3;
		const pos = fly(first, v0a, zero, ms);
		const vel = velocity((m) => fly(first, v0a, zero, m), ms);
		const next = second(pos);
		const { v0, rest } = matchVelocity(next, next.dur, vel, Math.exp(pos.lz), VH);
		assert.ok(v0 >= 0 && v0 <= 3);
		same(fly(next, v0, rest, 0), pos, 1e-9);
		const v = velocity((m) => fly(next, v0, rest, Math.max(0, m)), 0.01);
		same(v, vel, 2e-2);
		same(fly(next, v0, rest, next.dur), next.at(1), 1e-9);
	}
});

test("retarget against the motion reverses smoothly (no negative speed)", () => {
	const p = easePath(at(4), at(0), VH);
	const { v0, rest } = matchVelocity(p, p.dur, { cx: 0, cy: 2, lz: 0 }, zoom, VH);
	assert.equal(v0, 0);
	close(rest.cy, 2);
});
