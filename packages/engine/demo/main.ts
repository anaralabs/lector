import wasmUrl, { workerUrls } from "../src/vite-wasm";

// Module workers started from a blob loader, as a host app might (survives
// extensions that re-wrap workers, and cross-origin asset hosts).
const createWorker = (url: URL, name: string) =>
	new Worker(URL.createObjectURL(new Blob([`import(${JSON.stringify(url.href)})`], { type: "text/javascript" })), { name });
import { type CoreEvent, createViewer, preloadPdfium, type Viewer } from "../src";

// Benches read the core (window.__core, or self.__core in the compositor worker).
(globalThis as { __lectorEngineDebug?: boolean }).__lectorEngineDebug = true;

const params = new URLSearchParams(location.search);
// ?preload=1: compile pdfium.wasm before the viewer opens, as a host does at idle.
if (params.get("preload") === "1") await preloadPdfium(wasmUrl);
const src = params.get("file") ?? "/cadbots.pdf";
const offscreen = params.get("offscreen") !== "0";
const workers = params.has("workers") ? Number(params.get("workers")) : undefined;

const el = document.getElementById("viewer")!;
const hud = document.getElementById("hud")!;
const info: Record<string, string> = {};
const t0 = performance.now();
let zoom = 1;
let current = 0;

// Exposed for the benchmark harness.
const w = window as unknown as { __events: CoreEvent[]; __flights: CoreEvent[]; __errors: CoreEvent[]; __all: CoreEvent[]; __viewer?: Viewer; __firstPaintMs?: number };
w.__events = [];
w.__flights = [];
w.__errors = [];
// Every non-stats event, for feature checks (bounded).
w.__all = [];

// First time (ms since navigation) of each event, for the open-at bench.
const marks: Record<string, number> = {};
(window as unknown as { __marks: typeof marks }).__marks = marks;

// ?track=N: where the camera sits relative to page N's top on every camera event (a layout jump shows up as a spread).
const tracked = params.has("track") ? Number(params.get("track")) : -1;
let trackLayout: { y: number }[] = [];
const track = { first: Number.NaN, min: Infinity, max: -Infinity, samples: 0 };
(window as unknown as { __track: typeof track }).__track = track;

const onEvent = (e: CoreEvent) => {
	if (e.type === "ready" || e.type === "layout") trackLayout = e.layout;
	if (tracked >= 0 && e.type === "camera" && trackLayout[tracked] && w.__viewer) {
		const rel = w.__viewer.camera.y - trackLayout[tracked]!.y;
		if (Number.isNaN(track.first)) track.first = rel;
		track.min = Math.min(track.min, rel);
		track.max = Math.max(track.max, rel);
		track.samples++;
	}
	marks[e.type] ??= performance.now();
	if (e.type === "layout" && e.complete) marks["layout-complete"] ??= performance.now();
	if (e.type === "ready" && (e as { complete?: boolean }).complete === false) marks["ready-estimated"] = marks.ready!;
	if (e.type !== "stats" && e.type !== "camera") {
		w.__all.push(e);
		if (w.__all.length > 500) w.__all.splice(0, 250);
	}
	if (e.type === "error") w.__errors.push(e);
	if (e.type === "flight") w.__flights.push(e);
	if (e.type === "stats") {
		w.__events.push(e);
		const s = e.stats;
		info.fps = `${s.fps.toFixed(0)} fps  p95 ${s.p95FrameMs.toFixed(1)}ms  worst ${s.worstFrameMs.toFixed(1)}ms`;
		info.cpu = `frame cpu ${s.avgCpuMs.toFixed(2)}ms`;
		info.tiles = `tiles ${s.tiles}  gpu ${s.textureMB.toFixed(0)}MB  queue ${s.pendingJobs}`;
		info.raster = `tile raster ${s.avgTileMs.toFixed(1)}ms  ×${s.workers} workers (${s.workerMB.toFixed(0)}MB)  scale ${s.targetScale.toFixed(2)}`;
	} else if (e.type === "view") {
		zoom = e.zoom;
		current = e.page;
		info.view = `page ${e.page + 1}/${e.pageCount}  zoom ${(e.zoom * 100).toFixed(0)}%`;
	} else if (e.type === "painted") {
		(w as unknown as { __paintedMs: number }).__paintedMs = performance.now() - t0;
	} else if (e.type === "ready") {
		w.__firstPaintMs = performance.now() - t0;
		info.ready = `ready in ${w.__firstPaintMs.toFixed(0)}ms`;
	} else if (e.type === "selection") {
		if (e.final) info.sel = e.selection?.text ? `selected ${e.selection.text.length} chars` : "";
	} else if (e.type === "error") {
		info.error = e.message.slice(0, 200);
		// An expected password prompt is not a page error (benches count console errors).
		if (e.code === "password") console.warn(e.message);
		else console.error(e.message);
	}
	hud.textContent = Object.values(info).filter(Boolean).join("\n");
};

async function open(source: string | ArrayBuffer) {
	w.__viewer?.destroy();
	// ?dark=1 previews dark mode with near-black page colours.
	const dark = params.get("dark") === "1" ? { dark: true, background: [0.03, 0.03, 0.03] as [number, number, number], paper: [0.05, 0.05, 0.05] as [number, number, number] } : {};
	const password = params.get("password") ?? undefined;
	const interceptFind = params.get("interceptFind") === "1";
	const textLayer = params.get("textLayer") !== "0";
	const rangeLoading = params.get("range") === "1";
	const autoFetch = params.get("autoFetch") !== "0";
	const initial = {
		...(params.has("page") ? { initialPage: Number(params.get("page")) } : {}),
		...(params.has("top") ? { initialTop: Number(params.get("top")) } : {}),
		...(params.has("topFraction") ? { initialTarget: { page: Number(params.get("page") ?? 0), topFraction: Number(params.get("topFraction")) } } : {}),
		...(params.has("fraction") ? { initialTarget: { fraction: Number(params.get("fraction")) } } : {}),
		...(params.has("offset") ? { initialOffset: Number(params.get("offset")) } : {}),
		...(params.has("zoom") ? { initialZoom: params.get("zoom")!.startsWith("fit") ? (params.get("zoom") as "fit-page") : Number(params.get("zoom")) } : {}),
	};
	const viewer = await createViewer(el, source, { wasmUrl, offscreen, workers, onEvent, password, interceptFind, textLayer, rangeLoading, autoFetch, ...initial, ...dark, ...(params.get("loader") === "0" ? {} : { createWorker, workerUrls }) });
	w.__viewer = viewer;
	info.mode = `compositor: ${viewer.offscreen ? "worker (OffscreenCanvas)" : "main thread"}`;
	el.focus();
	return viewer;
}

let viewer = await open(src);
document.getElementById("zin")!.onclick = () => viewer.zoomTo(zoom * 1.25);
document.getElementById("zout")!.onclick = () => viewer.zoomTo(zoom / 1.25);
document.getElementById("fit")!.onclick = () => viewer.fitWidth();

let jank: ReturnType<typeof setInterval> | null = null;
const jankBtn = document.getElementById("jank")!;
jankBtn.onclick = () => {
	if (jank) {
		clearInterval(jank);
		jank = null;
	} else {
		jank = setInterval(() => {
			const end = performance.now() + 50;
			while (performance.now() < end) {}
		}, 100);
	}
	jankBtn.textContent = `jank: ${jank ? "on" : "off"}`;
};

document.getElementById("file")!.onchange = async (ev) => {
	const f = (ev.target as HTMLInputElement).files?.[0];
	if (f) viewer = await open(await f.arrayBuffer());
};

// Citation-jump polish A/B: ?polish=0 starts with the previous behaviour.
let polish = params.get("polish") !== "0";
// ?path=zoom-out tries the pull-back path instead of the glide.
const pathStyle = params.get("path") === "zoom-out" ? "zoom-out" : "glide";
let reduced = false;
const polishBtn = document.getElementById("polish")!;
const applyPolish = () => {
	viewer.setOptions({ flightPath: polish ? pathStyle : "cut", flightMotionBlur: polish, flightCarryVelocity: polish });
	polishBtn.textContent = `flight: ${polish ? `${pathStyle} + blur` : "cut (main)"}`;
};
applyPolish();
polishBtn.onclick = () => {
	polish = !polish;
	applyPolish();
};
const motionBtn = document.getElementById("motion")!;
motionBtn.onclick = () => {
	reduced = !reduced;
	viewer.setOptions({ reducedMotion: reduced });
	motionBtn.textContent = `motion: ${reduced ? "reduced" : "full"}`;
};

type Cite = { page: number; rect: { x: number; y: number; w: number; h: number }; rects: { x: number; y: number; w: number; h: number }[] };
const citeAt = async (page: number): Promise<Cite> => {
	const rects = await viewer.rects(page, 300, 560);
	const x0 = Math.min(...rects.map((r) => r.x));
	const y0 = Math.min(...rects.map((r) => r.y));
	const x1 = Math.max(...rects.map((r) => r.x + r.w));
	const y1 = Math.max(...rects.map((r) => r.y + r.h));
	return { page, rects, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
};
const pageCount = async () => (await viewer.loaded).pages.length;
const farFrom = async (p: number) => {
	const n = await pageCount();
	return p < n / 2 ? Math.min(n - 1, p + Math.max(3, Math.floor(n * 0.6))) : Math.max(0, p - Math.max(3, Math.floor(n * 0.6)));
};
let nextFar: Promise<Cite> | null = null;
const cite = async (c: Cite) => {
	viewer.setHighlights([{ id: "cite", page: c.page, rects: c.rects, color: [0.35, 0.6, 1, 0.45], interactive: false }]);
	const arrival = polish ? { ids: "cite", kind: "draw" as const, dim: true } : undefined;
	return viewer.reveal(c.page, c.rect, { animate: true, arrival });
};
const farBtn = document.getElementById("cite-far")!;
farBtn.onpointerenter = async () => {
	nextFar = farFrom(current).then(citeAt);
	const c = await nextFar;
	if (polish) viewer.prefetch(c.page, c.rect);
};
farBtn.onpointerleave = () => viewer.prefetch(null);
farBtn.onclick = async () => cite(await (nextFar ?? farFrom(current).then(citeAt)).finally(() => (nextFar = null)));
document.getElementById("cite-near")!.onclick = async () => cite(await citeAt(Math.min((await pageCount()) - 1, current + 2)));
// Three clicks 160ms apart: each retargets the moving camera.
document.getElementById("cite-chain")!.onclick = async () => {
	const n = await pageCount();
	const pages = [await farFrom(current), Math.floor(n / 2), Math.min(n - 1, current + 3)];
	const cites = await Promise.all(pages.map(citeAt));
	for (const c of cites) {
		void cite(c);
		await new Promise((r) => setTimeout(r, 160));
	}
};
