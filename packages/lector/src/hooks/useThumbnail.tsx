import { useEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { usePdf } from "../internal";
import { renderQueue } from "../lib/render-queue";
import { useDpr } from "./useDpr";
import { useVisibility } from "./useVisibility";

interface ThumbnailConfig {
	maxHeight?: number;
	maxWidth?: number;
	isFirstPage?: boolean;
}

const DEFAULT_CONFIG: Required<Omit<ThumbnailConfig, "isFirstPage">> = {
	maxHeight: 800,
	maxWidth: 400,
};

export const useThumbnail = (
	pageNumber: number,
	config: ThumbnailConfig = {},
) => {
	const {
		maxHeight = DEFAULT_CONFIG.maxHeight,
		maxWidth = DEFAULT_CONFIG.maxWidth,
		isFirstPage = false,
	} = config;

	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	// Track the queue job cancel fn so we can cancel before the render starts
	const cancelJobRef = useRef<(() => void) | null>(null);

	const pageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
	const { visible } = useVisibility({ elementRef: containerRef });
	const [debouncedVisible] = useDebounce(visible, 50);
	const dpr = useDpr();

	const isVisible = isFirstPage || debouncedVisible;

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !pageProxy) return;

		// Cancel any in-flight queue job or render from the previous effect run
		cancelJobRef.current?.();
		cancelJobRef.current = null;

		const viewport = pageProxy.getViewport({ scale: 1 });
		const scale =
			Math.min(maxWidth / viewport.width, maxHeight / viewport.height) *
			(isVisible ? dpr : 0.5);
		const scaledViewport = pageProxy.getViewport({ scale });

		let activeRenderTask: { cancel(): void } | null = null;

		const job = renderQueue.enqueue(() => {
			return new Promise<void>((resolve, reject) => {
				if (!canvasRef.current) {
					resolve();
					return;
				}

				canvas.width = scaledViewport.width;
				canvas.height = scaledViewport.height;

				const context = canvas.getContext("2d");
				if (!context) {
					resolve();
					return;
				}

				const renderTask = pageProxy.render({
					canvas,
					canvasContext: context,
					viewport: scaledViewport,
				});
				activeRenderTask = renderTask;

				renderTask.promise
					.then(() => {
						activeRenderTask = null;
						resolve();
					})
					.catch((error: unknown) => {
						activeRenderTask = null;
						if (
							error instanceof Error &&
							error.name === "RenderingCancelledException"
						) {
							resolve();
						} else {
							reject(error);
						}
					});
			});
		}, "background");

		cancelJobRef.current = () => {
			job.cancel();
			activeRenderTask?.cancel();
		};

		// Capture ref — React clears refs before passive cleanup runs on unmount
		return () => {
			cancelJobRef.current?.();
			cancelJobRef.current = null;
			// Release canvas memory for Safari (384 MB total canvas limit on iOS)
			if (canvas) {
				canvas.width = 1;
				canvas.height = 1;
			}
		};
	}, [pageProxy, isVisible, dpr, maxHeight, maxWidth]);

	return {
		canvasRef,
		containerRef,
		isVisible,
	};
};
