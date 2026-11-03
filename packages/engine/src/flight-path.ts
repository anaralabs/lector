// Camera paths for animated reveal/goto. Pure math, so it is unit-tested
// without a GPU. A path maps progress (0-1) to a camera; the core maps time
// to progress with `progress`, which can start at any speed (retargets).

export interface Cam {
	x: number;
	y: number;
	zoom: number;
}

/** Camera centre (doc points) and log zoom: the space paths and velocities live in. */
export interface CamState {
	cx: number;
	cy: number;
	lz: number;
}

export interface Path {
	/** "ease": main's straight ease; "glide": one continuous move, any distance; "zoom": van Wijk & Nuij zoom-out/zoom-in */
	kind: "ease" | "glide" | "zoom";
	at(h: number): CamState;
	/** suggested duration, ms */
	dur: number;
	/** doc distance skipped at the peak of a capped zoom path (0 when nothing is cut) */
	skip: number;
	/** progress at which the skip happens (Infinity when nothing is cut) */
	cutAt: number;
	/** lowest zoom on the path */
	minZoom: number;
}

/** van Wijk & Nuij's rho (their user study's ~1.4): how much to zoom out per unit of travel */
const RHO = 1.42;
const RHO2 = RHO * RHO;
const RHO4 = RHO2 * RHO2;

export function toState(c: Cam, vw: number, vh: number): CamState {
	return { cx: c.x + vw / 2 / c.zoom, cy: c.y + vh / 2 / c.zoom, lz: Math.log(c.zoom) };
}

export function fromState(s: CamState, vw: number, vh: number): Cam {
	const zoom = Math.exp(s.lz);
	return { x: s.cx - vw / 2 / zoom, y: s.cy - vh / 2 / zoom, zoom };
}

/**
 * Time -> progress: a cubic that starts at speed `v0` (progress per unit time)
 * and lands at rest. v0 = 3 is easeOutCubic, v0 = 0 is smoothstep. Never overshoots.
 */
export function progress(t: number, v0: number) {
	if (t <= 0) return 0;
	if (t >= 1) return 1;
	const v = Math.max(0, Math.min(3, v0));
	const t2 = t * t;
	const t3 = t2 * t;
	return v * (t3 - 2 * t2 + t) + 3 * t2 - 2 * t3;
}

/** Bump that leaves 0 with slope 1 and returns to 0 at rest: carries a residual velocity into a path. */
export function kick(t: number) {
	if (t <= 0 || t >= 1) return 0;
	return t * (1 - t) * (1 - t);
}

/** The pre-existing flight: centre in a straight line, zoom in log space. */
export function easePath(a: CamState, b: CamState, vh: number): Path {
	const zoomSteps = Math.abs(b.lz - a.lz) / Math.LN2;
	const dist = Math.hypot(b.cx - a.cx, b.cy - a.cy) * Math.exp(b.lz);
	const travel = dist / vh + zoomSteps * 0.5;
	return {
		kind: "ease",
		at: (h) => ({ cx: a.cx + (b.cx - a.cx) * h, cy: a.cy + (b.cy - a.cy) * h, lz: a.lz + (b.lz - a.lz) * h }),
		dur: Math.min(600, Math.max(220, 180 + 90 * Math.log2(1 + travel))),
		skip: 0,
		cutAt: Infinity,
		minZoom: Math.exp(Math.min(a.lz, b.lz)),
	};
}

/**
 * One continuous move straight to the target, however far: the duration grows
 * with the log of the distance and is capped, so far jumps just move faster.
 */
export function glidePath(a: CamState, b: CamState, vh: number): Path {
	const zoomSteps = Math.abs(b.lz - a.lz) / Math.LN2;
	const travel = (Math.hypot(b.cx - a.cx, b.cy - a.cy) * Math.exp(b.lz)) / vh + zoomSteps * 0.5;
	return {
		kind: "glide",
		at: (h) => ({ cx: a.cx + (b.cx - a.cx) * h, cy: a.cy + (b.cy - a.cy) * h, lz: a.lz + (b.lz - a.lz) * h }),
		dur: Math.min(600, Math.max(240, 180 + 70 * Math.log2(1 + travel))),
		skip: 0,
		cutAt: Infinity,
		minZoom: Math.exp(Math.min(a.lz, b.lz)),
	};
}

interface Wijk {
	S: number;
	u: (s: number) => number;
	w: (s: number) => number;
	/** widest view on the path and where (s) it happens */
	peak: number;
	sPeak: number;
}

/** van Wijk & Nuij (2003) optimal path from view width w0 to w1 across distance d. */
function wijk(w0: number, w1: number, d: number): Wijk {
	if (d < 1e-6 * Math.max(w0, w1)) {
		const k = w1 < w0 ? -1 : 1;
		const S = Math.abs(Math.log(w1 / w0)) / RHO;
		return { S, u: (s) => (S ? (d * s) / S : 0), w: (s) => w0 * Math.exp(k * RHO * s), peak: Math.max(w0, w1), sPeak: w1 > w0 ? S : 0 };
	}
	const b0 = (w1 * w1 - w0 * w0 + RHO4 * d * d) / (2 * w0 * RHO2 * d);
	const b1 = (w1 * w1 - w0 * w0 - RHO4 * d * d) / (2 * w1 * RHO2 * d);
	const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
	const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
	const S = (r1 - r0) / RHO;
	const c0 = Math.cosh(r0);
	const s0 = Math.sinh(r0);
	const u = (s: number) => (w0 / RHO2) * (c0 * Math.tanh(RHO * s + r0) - s0);
	const w = (s: number) => (w0 * c0) / Math.cosh(RHO * s + r0);
	const sTop = -r0 / RHO;
	const inside = sTop > 0 && sTop < S;
	const peak = inside ? w0 * c0 : Math.max(w0, w1);
	return { S, u, w, peak, sPeak: inside ? sTop : w1 > w0 ? S : 0 };
}

export interface ZoomPathOptions {
	/** widest view height (doc points) the path may pull back to */
	capW: number;
	/** adjusts a skip distance (doc points along the path) so the cut lands on an identical-looking spot; returns the new skip */
	snapSkip?: (skip: number, at: CamState, dir: { x: number; y: number }) => number;
}

/**
 * Pull back, travel, push in. View size is the viewport height in doc points.
 * When the optimal path would pull back past `capW`, the middle of the travel
 * is skipped at the widest point (where the motion is fastest and the view is
 * smallest) instead of zooming out further or crawling across the gap.
 */
export function zoomPath(a: CamState, b: CamState, vh: number, o: ZoomPathOptions): Path {
	const w0 = vh / Math.exp(a.lz);
	const w1 = vh / Math.exp(b.lz);
	const dx = b.cx - a.cx;
	const dy = b.cy - a.cy;
	const d = Math.hypot(dx, dy);
	const dir = d > 0 ? { x: dx / d, y: dy / d } : { x: 0, y: 1 };
	const capW = Math.max(o.capW, w0, w1);
	let p = wijk(w0, w1, d);
	let skip = 0;
	if (p.peak > capW * 1.0001) {
		let lo = 0;
		let hi = d;
		for (let i = 0; i < 40; i++) {
			const mid = (lo + hi) / 2;
			if (wijk(w0, w1, mid).peak > capW) hi = mid;
			else lo = mid;
		}
		skip = d - lo;
		if (o.snapSkip) {
			const at0 = wijk(w0, w1, d - skip);
			const cut = at0.u(at0.sPeak);
			const snapped = o.snapSkip(skip, { cx: a.cx + dir.x * cut, cy: a.cy + dir.y * cut, lz: Math.log(vh / at0.peak) }, dir);
			if (Number.isFinite(snapped) && snapped >= 0 && snapped < d) skip = snapped;
		}
		p = wijk(w0, w1, d - skip);
	}
	const cutU = skip > 0 ? p.u(p.sPeak) : Infinity;
	const S = p.S;
	return {
		kind: "zoom",
		at: (h) => {
			const s = S * Math.max(0, Math.min(1, h));
			let u = p.u(s);
			if (u >= cutU) u += skip;
			if (h >= 1) u = d;
			const w = h >= 1 ? w1 : p.w(s);
			return { cx: a.cx + dir.x * u, cy: a.cy + dir.y * u, lz: Math.log(vh / w) };
		},
		dur: Math.min(560, Math.max(300, 260 + 90 * S)),
		skip,
		cutAt: skip > 0 && S > 0 ? p.sPeak / S : Infinity,
		minZoom: vh / p.peak,
	};
}

/** Progress-space tangent of a path at its start (state units per unit progress). */
export function startTangent(path: Path): CamState {
	const e = 1e-3;
	const a = path.at(0);
	const b = path.at(e);
	return { cx: (b.cx - a.cx) / e, cy: (b.cy - a.cy) / e, lz: (b.lz - a.lz) / e };
}

/**
 * Splits a camera velocity (state units per ms) into the start speed of `path`
 * (v0 for `progress`) and a residual the `kick` bump carries off. Positions are
 * weighted in screen px and zoom in viewport heights, so neither dominates.
 */
export function matchVelocity(path: Path, dur: number, vel: CamState, zoom: number, vh: number): { v0: number; rest: CamState } {
	const T = startTangent(path);
	const wp = zoom * zoom;
	const wz = vh * vh;
	const tt = (T.cx * T.cx + T.cy * T.cy) * wp + T.lz * T.lz * wz;
	const vt = (vel.cx * T.cx + vel.cy * T.cy) * wp + vel.lz * T.lz * wz;
	const v0 = tt > 0 ? Math.max(0, Math.min(3, (vt / tt) * dur)) : 0;
	const k = v0 / dur;
	return { v0, rest: { cx: vel.cx - T.cx * k, cy: vel.cy - T.cy * k, lz: vel.lz - T.lz * k } };
}
