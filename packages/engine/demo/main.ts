import wasmUrl, { workerUrls } from "../src/vite-wasm";

// Same setup as anara: module workers started from a blob loader (survives
// extensions that re-wrap workers, and cross-origin asset hosts).
const createWorker = (url: URL, name: string) =>
	new Worker(URL.createObjectURL(new Blob([`import(${JSON.stringify(url.href)})`], { type: "text/javascript" })), { name });
import { type CoreEvent, createViewer, type Viewer } from "../src";

const params = new URLSearchParams(location.search);
const src = params.get("file") ?? "/cadbots.pdf";
const offscreen = params.get("offscreen") !== "0";
const workers = params.has("workers") ? Number(params.get("workers")) : undefined;

const el = document.getElementById("viewer")!;
const hud = document.getElementById("hud")!;
const info: Record<string, string> = {};
const t0 = performance.now();
let zoom = 1;

// Exposed for the benchmark harness.
const w = window as unknown as { __events: CoreEvent[]; __flights: CoreEvent[]; __viewer?: Viewer; __firstPaintMs?: number };
w.__events = [];
w.__flights = [];

const onEvent = (e: CoreEvent) => {
	if (e.type === "flight") w.__flights.push(e);
	if (e.type === "stats") {
		w.__events.push(e);
		const s = e.stats;
		info.fps = `${s.fps.toFixed(0)} fps  p95 ${s.p95FrameMs.toFixed(1)}ms  worst ${s.worstFrameMs.toFixed(1)}ms`;
		info.cpu = `frame cpu ${s.avgCpuMs.toFixed(2)}ms`;
		info.tiles = `tiles ${s.tiles}  gpu ${s.textureMB.toFixed(0)}MB  queue ${s.pendingJobs}`;
		info.raster = `tile raster ${s.avgTileMs.toFixed(1)}ms  ×${s.workers} workers  scale ${s.targetScale.toFixed(2)}`;
	} else if (e.type === "view") {
		zoom = e.zoom;
		info.view = `page ${e.page + 1}/${e.pageCount}  zoom ${(e.zoom * 100).toFixed(0)}%`;
	} else if (e.type === "ready") {
		w.__firstPaintMs = performance.now() - t0;
		info.ready = `ready in ${w.__firstPaintMs.toFixed(0)}ms`;
	} else if (e.type === "selection") {
		if (e.final) info.sel = e.selection?.text ? `selected ${e.selection.text.length} chars` : "";
	} else if (e.type === "error") {
		info.error = e.message.slice(0, 200);
		console.error(e.message);
	}
	hud.textContent = Object.values(info).filter(Boolean).join("\n");
};

async function open(source: string | ArrayBuffer) {
	w.__viewer?.destroy();
	// ?dark=1 previews dark mode with anara-like colours.
	const dark = params.get("dark") === "1" ? { dark: true, background: [0.03, 0.03, 0.03] as [number, number, number], paper: [0.05, 0.05, 0.05] as [number, number, number] } : {};
	const viewer = await createViewer(el, source, { wasmUrl, offscreen, workers, onEvent, ...dark, ...(params.get("loader") === "0" ? {} : { createWorker, workerUrls }) });
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
