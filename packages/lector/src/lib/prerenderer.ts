import type { PDFPageProxy, RenderTask } from "pdfjs-dist";

import { bitmapCache } from "./bitmap-cache";

const requestIdle = (cb: () => void): number => {
	if (typeof requestIdleCallback !== "undefined") {
		return requestIdleCallback(cb);
	}
	return setTimeout(cb, 16) as unknown as number;
};

const cancelIdle = (id: number) => {
	if (typeof cancelIdleCallback !== "undefined") {
		cancelIdleCallback(id);
	} else {
		clearTimeout(id);
	}
};

interface PrerenderJob {
	pageNumber: number;
	scale: number;
	pageProxy: PDFPageProxy;
}

let currentRenderTask: RenderTask | null = null;
let idleHandle: number | null = null;
let jobQueue: PrerenderJob[] = [];

const processNext = () => {
	if (jobQueue.length === 0) return;

	const job = jobQueue.shift()!;

	if (bitmapCache.has(job.pageNumber, job.scale)) {
		scheduleNext();
		return;
	}

	const viewport = job.pageProxy.getViewport({ scale: job.scale });
	const width = Math.floor(viewport.width);
	const height = Math.floor(viewport.height);

	if (width <= 0 || height <= 0) {
		scheduleNext();
		return;
	}

	let offscreen: OffscreenCanvas;
	try {
		offscreen = new OffscreenCanvas(width, height);
	} catch {
		return;
	}

	const ctx = offscreen.getContext("2d");
	if (!ctx) {
		scheduleNext();
		return;
	}

	currentRenderTask = job.pageProxy.render({
		canvasContext: ctx as unknown as CanvasRenderingContext2D,
		viewport,
	});

	currentRenderTask.promise
		.then(() => {
			const bitmap = offscreen.transferToImageBitmap();
			bitmapCache.set(job.pageNumber, job.scale, bitmap);
		})
		.catch(() => {})
		.finally(() => {
			currentRenderTask = null;
			scheduleNext();
		});
};

const scheduleNext = () => {
	if (jobQueue.length === 0) return;

	idleHandle = requestIdle(() => {
		idleHandle = null;
		processNext();
	});
};

export const prerenderPages = (jobs: PrerenderJob[]) => {
	cancelPrerender();

	jobQueue = jobs.filter((j) => !bitmapCache.has(j.pageNumber, j.scale));

	if (jobQueue.length > 0) {
		scheduleNext();
	}
};

export const cancelPrerender = () => {
	jobQueue = [];
	if (idleHandle !== null) {
		cancelIdle(idleHandle);
		idleHandle = null;
	}
	if (currentRenderTask) {
		void currentRenderTask.cancel();
		currentRenderTask = null;
	}
};
