// Main-thread shell: owns the <canvas>, spawns workers, forwards input and
// mirrors the little state the DOM needs (cursor, copied text).

import {
	type Command,
	type CoreEvent,
	type CoreOptions,
	type InputMsg,
	type PointerKind,
	type Request,
	type SearchHit,
	ViewerCore,
} from "./core";
import type { OutlineItem } from "./protocol";
import type { Rect } from "./text";

export interface ViewerOptions extends Partial<CoreOptions> {
	/** URL of pdfium.wasm (from `@embedpdf/pdfium/pdfium.wasm`) */
	wasmUrl: string;
	/** number of PDFium raster workers (default: half the cores, 2-4) */
	workers?: number;
	/** run the compositor in a worker with an OffscreenCanvas (default: when supported) */
	offscreen?: boolean;
	onEvent?: (e: CoreEvent) => void;
	/** external link clicked; default opens it in a new tab */
	onLink?: (url: string) => void;
}

export interface Viewer {
	readonly canvas: HTMLCanvasElement;
	readonly offscreen: boolean;
	zoomTo(zoom: number): void;
	fitWidth(): void;
	goToPage(page: number, top?: number): void;
	/** centre a page-space rect (zooming out if needed), e.g. a citation */
	reveal(page: number, rect: Rect): void;
	select(page: number, from: number, to: number): void;
	search(query: string, limit?: number): Promise<SearchHit[]>;
	outline(): Promise<OutlineItem[]>;
	pageText(page: number): Promise<string>;
	setHighlights(items: Extract<Command, { type: "highlights" }>["items"]): void;
	clearSelection(): void;
	setOptions(options: Partial<CoreOptions>): void;
	/** text of the current selection ("" when nothing is selected) */
	readonly selectedText: string;
	destroy(): void;
}

const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End", " ", "Escape"]);

export async function createViewer(container: HTMLElement, source: string | ArrayBuffer | Uint8Array, options: ViewerOptions): Promise<Viewer> {
	const { wasmUrl, workers: workerCount, offscreen: wantOffscreen, onEvent, onLink, ...coreOptions } = options;
	const bytes =
		typeof source === "string"
			? new Uint8Array(await (await fetch(source)).arrayBuffer())
			: source instanceof Uint8Array
				? source
				: new Uint8Array(source);

	const canvas = document.createElement("canvas");
	canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;";
	if (getComputedStyle(container).position === "static") container.style.position = "relative";
	container.style.overflow = "hidden";
	container.style.touchAction = "none";
	container.style.userSelect = "none";
	(container.style as CSSStyleDeclaration & { webkitUserSelect: string }).webkitUserSelect = "none";
	if (container.tabIndex < 0) container.tabIndex = 0;
	container.appendChild(canvas);

	// Raster workers. Each gets its own copy of the bytes and a port to the core.
	const n = workerCount ?? Math.min(4, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
	const rasterWorkers: Worker[] = [];
	const corePorts: MessagePort[] = [];
	for (let i = 0; i < n; i++) {
		const worker = new Worker(new URL("./raster-worker.ts", import.meta.url), { type: "module", name: `lector-raster-${i}` });
		const channel = new MessageChannel();
		const copy = bytes.slice().buffer;
		worker.postMessage({ t: "init", bytes: copy, port: channel.port1, wasmUrl }, [copy, channel.port1]);
		rasterWorkers.push(worker);
		corePorts.push(channel.port2);
	}

	let selectedText = "";
	const pending = new Map<number, (result: unknown) => void>();
	const handleEvent = (e: CoreEvent) => {
		if (e.type === "cursor") container.style.cursor = e.cursor;
		else if (e.type === "selection") {
			if (e.final) selectedText = e.selection?.text ?? "";
		} else if (e.type === "link") {
			if (onLink) onLink(e.url);
			else if (/^(https?|mailto):/i.test(e.url)) window.open(e.url, "_blank", "noopener,noreferrer");
		} else if (e.type === "response") {
			pending.get(e.id)?.(e.result);
			pending.delete(e.id);
			return;
		}
		onEvent?.(e);
	};

	const useOffscreen = (wantOffscreen ?? true) && typeof canvas.transferControlToOffscreen === "function";
	let coreWorker: Worker | null = null;
	let core: ViewerCore | null = null;
	if (useOffscreen) {
		const offscreen = canvas.transferControlToOffscreen();
		coreWorker = new Worker(new URL("./core-worker.ts", import.meta.url), { type: "module", name: "lector-compositor" });
		coreWorker.onmessage = (ev: MessageEvent<CoreEvent>) => handleEvent(ev.data);
		coreWorker.postMessage({ t: "init", canvas: offscreen, ports: corePorts, options: coreOptions }, [offscreen, ...corePorts]);
	} else {
		core = new ViewerCore(canvas, corePorts, handleEvent, (cb) => requestAnimationFrame(cb), coreOptions);
		(globalThis as { __core?: ViewerCore }).__core = core;
	}

	const send = (msg: InputMsg) => {
		if (core) core.handle(msg);
		else coreWorker!.postMessage({ t: "input", msg });
	};
	const command = (cmd: Command) => {
		if (core) core.command(cmd);
		else coreWorker!.postMessage({ t: "command", cmd });
	};
	let nextRequest = 1;
	const request = <T>(req: Request) =>
		new Promise<T>((resolve, reject) => {
			const id = nextRequest++;
			pending.set(id, (result) => {
				const error = (result as { error?: string } | null)?.error;
				if (error) reject(new Error(error));
				else resolve(result as T);
			});
			command({ type: "request", id, request: req });
		});

	// ------------------------------------------------------------ input
	let rect = container.getBoundingClientRect();
	const local = (e: { clientX: number; clientY: number }) => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
	const ac = new AbortController();
	const on = <K extends keyof HTMLElementEventMap>(
		target: HTMLElement | Document | Window,
		type: K | string,
		fn: (e: any) => void,
		opts: AddEventListenerOptions = {},
	) => target.addEventListener(type, fn, { ...opts, signal: ac.signal });

	const resize = () => {
		rect = container.getBoundingClientRect();
		send({ type: "resize", w: rect.width, h: rect.height, dpr: window.devicePixelRatio || 1 });
	};
	const ro = new ResizeObserver(resize);
	ro.observe(container);
	resize();
	// Rect moves when an ancestor scrolls; DPR changes when the window moves screens.
	on(window, "scroll", () => (rect = container.getBoundingClientRect()), { capture: true, passive: true });
	let dprQuery: MediaQueryList | null = null;
	const watchDpr = () => {
		dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
		dprQuery.addEventListener(
			"change",
			() => {
				resize();
				watchDpr();
			},
			{ once: true, signal: ac.signal },
		);
	};
	watchDpr();

	on(
		container,
		"wheel",
		(e: WheelEvent) => {
			e.preventDefault();
			const p = local(e);
			send({ type: "wheel", x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY, ctrl: e.ctrlKey, mode: e.deltaMode });
		},
		{ passive: false },
	);

	// Safari (macOS) delivers trackpad pinch as gesture events, not ctrl+wheel.
	let touchCount = 0;
	const gesture = (phase: "start" | "change" | "end") => (e: Event & { scale: number; clientX: number; clientY: number }) => {
		e.preventDefault();
		if (touchCount > 0) return; // iOS: pinch is handled from pointer events
		const p = local(e);
		send({ type: "gesture", phase, x: p.x, y: p.y, scale: e.scale });
	};
	on(container, "gesturestart", gesture("start"));
	on(container, "gesturechange", gesture("change"));
	on(container, "gestureend", gesture("end"));

	const pointer = (phase: "down" | "move" | "up" | "cancel") => (e: PointerEvent) => {
		const kind = (e.pointerType || "mouse") as PointerKind;
		if (kind === "touch") {
			if (phase === "down") touchCount++;
			if (phase === "up" || phase === "cancel") touchCount = Math.max(0, touchCount - 1);
		}
		if (phase === "down") {
			container.focus({ preventScroll: true });
			if (e.button === 0) canvas.setPointerCapture(e.pointerId);
		}
		const p = local(e);
		send({ type: "pointer", phase, id: e.pointerId, x: p.x, y: p.y, buttons: e.buttons, kind, clicks: e.detail, shift: e.shiftKey });
	};
	on(canvas, "pointerdown", pointer("down"));
	on(canvas, "pointermove", pointer("move"));
	on(canvas, "pointerup", pointer("up"));
	on(canvas, "pointercancel", pointer("cancel"));
	on(canvas, "pointerleave", () => send({ type: "leave" }));
	on(canvas, "touchstart", (e: TouchEvent) => e.preventDefault(), { passive: false });

	on(container, "keydown", (e: KeyboardEvent) => {
		const mod = e.metaKey || e.ctrlKey;
		const zoomKey = mod && ["=", "+", "-", "0"].includes(e.key);
		if (!zoomKey && !NAV_KEYS.has(e.key)) return;
		e.preventDefault();
		send({ type: "key", key: e.key, mod, shift: e.shiftKey });
	});

	on(document, "copy", (e: ClipboardEvent) => {
		if (!selectedText || !container.contains(document.activeElement)) return;
		e.clipboardData?.setData("text/plain", selectedText);
		e.preventDefault();
	});

	return {
		canvas,
		offscreen: useOffscreen,
		zoomTo: (zoom) => command({ type: "zoom", zoom }),
		fitWidth: () => command({ type: "fit-width" }),
		goToPage: (page, top) => command({ type: "goto", page, top }),
		reveal: (page, rect) => command({ type: "reveal", page, rect }),
		select: (page, from, to) => command({ type: "select", page, from, to }),
		search: (query, limit) => request<SearchHit[]>({ type: "search", query, limit }),
		outline: () => request<OutlineItem[]>({ type: "outline" }),
		pageText: (page) => request<string>({ type: "page-text", page }),
		setHighlights: (items) => command({ type: "highlights", items }),
		clearSelection: () => command({ type: "clear-selection" }),
		setOptions: (o) => command({ type: "options", options: o }),
		get selectedText() {
			return selectedText;
		},
		destroy() {
			ac.abort();
			ro.disconnect();
			for (const w of rasterWorkers) w.terminate();
			coreWorker?.terminate();
			canvas.remove();
		},
	};
}
