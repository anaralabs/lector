import wasmUrl, { workerUrls } from "../src/vite-wasm";

// Module workers started from a blob loader, as a host app might (survives
// extensions that re-wrap workers, and cross-origin asset hosts).
const params0 = new URLSearchParams(location.search);
// bench/worker-faults.mjs: ?fault=<page> crashes PDFium for good on that page in every raster worker; ?bootOom=<n> fails the first n raster workers to reserve memory.
const faultPage = params0.has("fault") ? Number(params0.get("fault")) : -1;
let bootOoms = Number(params0.get("bootOom") ?? 0);
const faultShim = (oom: boolean) => `
let real = null;
Object.defineProperty(self, "onmessage", { configurable: true, get: () => real, set: (fn) => { real = fn; } });
self.addEventListener("message", (ev) => {
	const d = ev.data;
	if (!d || d.t !== "init") return real && real(ev);
	const core = d.port;
	if (${oom}) return core.postMessage({ t: "error", message: "lector-engine: pdfium.wasm failed to load: WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance", code: "wasm", phase: "engine-load", trap: "oom" });
	const ch = new MessageChannel();
	core.onmessage = (e) => {
		const m = e.data;
		if ((m.t === "tile" || m.t === "text") && m.page === ${faultPage}) return core.postMessage({ t: "error", message: "lector-engine: PDFium trap on page ${faultPage + 1} in injected (could not restart it): unreachable", code: "wasm-trap", phase: m.t === "text" ? "text" : "render", id: m.id, page: m.page, op: "injected", recovered: false, trap: "trap" });
		ch.port1.postMessage(m);
	};
	ch.port1.onmessage = (e) => core.postMessage(e.data);
	real({ data: { ...d, port: ch.port2 } });
});
`;
const createWorker = (url: URL, name: string) => {
	const raster = name.startsWith("lector-raster");
	const oom = raster && bootOoms > 0;
	if (oom) bootOoms--;
	const shim = raster && (oom || faultPage >= 0) ? faultShim(oom) : "";
	return new Worker(URL.createObjectURL(new Blob([`${shim}import(${JSON.stringify(url.href)})`], { type: "text/javascript" })), { name });
};
import { type CoreEvent, createPageRenderer, createViewer, preloadPdfium, type Viewer, type ViewerSource } from "../src";

// Benches read the core (window.__core, or self.__core in the compositor worker).
(globalThis as { __lectorEngineDebug?: boolean }).__lectorEngineDebug = true;

// bench/render-region.mjs renders regions headless through this.
(window as unknown as { __pageRenderer: unknown }).__pageRenderer = createPageRenderer({ wasmUrl, workerUrl: workerUrls.raster, createWorker });

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

const download = (url: string) => fetch(url, { credentials: "same-origin" }).then((res) => res.arrayBuffer());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ?hostDelay=N: the viewer is created N ms after the URL is known, as in a host that loads its viewer chunk first.
// &prefetch=promise: the host downloads from the start and hands the pending bytes over; =wait: it waits for them, then opens.
async function hostSource(url: string): Promise<{ source: ViewerSource }> {
	marks.host = performance.now();
	const delay = Number(params.get("hostDelay") ?? 0);
	const mode = params.get("prefetch");
	const bytes = mode ? download(url) : null;
	await sleep(delay);
	if (mode === "wait" && bytes) return { source: await bytes };
	return { source: bytes ?? url };
}

async function open(source: ViewerSource) {
	w.__viewer?.destroy();
	// ?dark=1 previews dark mode with near-black page colours.
	const dark = params.get("dark") === "1" ? { dark: true, background: [0.03, 0.03, 0.03] as [number, number, number], paper: [0.05, 0.05, 0.05] as [number, number, number] } : {};
	const password = params.get("password") ?? undefined;
	const interceptFind = params.get("interceptFind") === "1";
	const textLayer = params.get("textLayer") !== "0";
	const rangeLoading = params.get("range") === "1";
	const autoFetch = params.get("autoFetch") !== "0";
	// ?cache=1: persistent base-bitmap cache (reopen the page to see it serve)
	const tileCache = params.get("cache") === "1";
	const initial = {
		...(params.has("page") ? { initialPage: Number(params.get("page")) } : {}),
		...(params.has("top") ? { initialTop: Number(params.get("top")) } : {}),
		...(params.has("topFraction") ? { initialTarget: { page: Number(params.get("page") ?? 0), topFraction: Number(params.get("topFraction")) } } : {}),
		...(params.has("fraction") ? { initialTarget: { fraction: Number(params.get("fraction")) } } : {}),
		...(params.has("offset") ? { initialOffset: Number(params.get("offset")) } : {}),
		...(params.has("zoom") ? { initialZoom: params.get("zoom")!.startsWith("fit") ? (params.get("zoom") as "fit-page") : Number(params.get("zoom")) } : {}),
	};
	const viewer = await createViewer(el, source, { wasmUrl, offscreen, workers, onEvent, password, interceptFind, textLayer, rangeLoading, autoFetch, tileCache, compositor: (params.get("compositor") ?? "auto") as "auto", motionResolution: params.get("motionRes") !== "0", ...initial, ...dark, ...(params.get("loader") === "0" ? {} : { createWorker, workerUrls }) });
	w.__viewer = viewer;
	info.mode = `compositor: ${viewer.compositor} ${viewer.offscreen ? "worker (OffscreenCanvas)" : "main thread"}`;
	el.focus();
	return viewer;
}

let viewer = await open((await hostSource(src)).source);
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
