import type { PDFPageProxy } from "pdfjs-dist";

import { clampScaleForPage } from "./canvas-utils";
import { getCachedBitmap, setCachedBitmap } from "./canvas-bitmap-cache";

const PRERASTERIZE_BACKGROUND = "white";

function computeBaseScale(proxy: PDFPageProxy, dpr: number): number {
	const viewport = proxy.getViewport({ scale: 1 });
	const target = dpr * 1; // zoom=1, matches useCanvasLayer base scale
	return clampScaleForPage(target, viewport.width, viewport.height);
}

function getDpr(): number {
	if (typeof window === "undefined") return 1;
	return Math.min(window.devicePixelRatio || 1, 2);
}

function makeOffscreenCanvas(
	width: number,
	height: number,
): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null } {
	if (typeof OffscreenCanvas !== "undefined") {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		return { canvas, ctx };
	}
	if (typeof document !== "undefined") {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		return { canvas, ctx };
	}
	return { canvas: null as unknown as HTMLCanvasElement, ctx: null };
}

async function rasterizePage(
	docId: string,
	proxy: PDFPageProxy,
	dpr: number,
	signal: { cancelled: boolean },
): Promise<void> {
	const baseScale = computeBaseScale(proxy, dpr);
	if (!baseScale) return;
	if (getCachedBitmap(proxy, baseScale, PRERASTERIZE_BACKGROUND)) return;

	const viewport = proxy.getViewport({ scale: baseScale });
	const width = Math.floor(viewport.width);
	const height = Math.floor(viewport.height);
	if (width <= 0 || height <= 0) return;

	const { canvas, ctx } = makeOffscreenCanvas(width, height);
	if (!canvas || !ctx) return;

	const renderingTask = proxy.render({
		// pdfjs accepts either; pass both to satisfy both code paths.
		canvas: canvas as unknown as HTMLCanvasElement,
		canvasContext: ctx as unknown as CanvasRenderingContext2D,
		viewport,
		background: PRERASTERIZE_BACKGROUND,
	});

	try {
		await renderingTask.promise;
	} catch (error: unknown) {
		if ((error as { name?: string })?.name === "RenderingCancelledException") {
			return;
		}
		return;
	}

	if (signal.cancelled) return;
	if (typeof createImageBitmap === "undefined") return;

	try {
		const bitmap = await createImageBitmap(
			canvas as unknown as ImageBitmapSource,
		);
		if (signal.cancelled) {
			bitmap.close();
			return;
		}
		setCachedBitmap(docId, proxy, baseScale, PRERASTERIZE_BACKGROUND, bitmap);
	} catch {
		// ignore; layer will render on demand
	}
}

export type PrerasterizeHandle = {
	cancel: () => void;
};

export function prerasterizeAllPages(
	docId: string,
	pageProxies: PDFPageProxy[],
): PrerasterizeHandle {
	const signal = { cancelled: false };
	const dpr = getDpr();

	void (async () => {
		// Serialize so we don't blow up the worker queue / memory on giant docs.
		for (const proxy of pageProxies) {
			if (signal.cancelled) return;
			await rasterizePage(docId, proxy, dpr, signal);
		}
	})();

	return {
		cancel: () => {
			signal.cancelled = true;
		},
	};
}
