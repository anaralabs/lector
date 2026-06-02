import type React from "react";
import { useLayoutEffect, useRef } from "react";

import { PDFStore, usePdf } from "../../internal";
import { getFitWidthZoom } from "../../lib/zoom";

interface UseFitWidth {
	viewportRef: React.RefObject<HTMLDivElement | null>;
}

const RESIZE_QUIET_MS = 200;

export const useFitWidth = ({ viewportRef }: UseFitWidth) => {
	const viewports = usePdf((state) => state.viewports);
	const zoomOptions = usePdf((state) => state.zoomOptions);

	const updateZoom = usePdf((state) => state.updateZoom);
	const setIsResizing = usePdf((state) => state.setIsResizing);
	const store = PDFStore.useContext();

	const pendingFrameRef = useRef<number | null>(null);
	const latestWidthRef = useRef<number | null>(null);

	useLayoutEffect(() => {
		if (viewportRef.current === null) return;
		let quietTimer: ReturnType<typeof setTimeout> | null = null;
		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (entry.target !== viewportRef.current) continue;
				const prevWidth = latestWidthRef.current;
				latestWidthRef.current = entry.contentRect.width;

				// Enter resizing mode on a real width change only. The initial
				// observe() callback (and height-only resizes) must not flip it:
				// useCanvasLayer cancels in-flight renders on the change, so that
				// would restart every page's first render on mount. Cleared once
				// the observer has been quiet for RESIZE_QUIET_MS.
				if (prevWidth !== null && prevWidth !== entry.contentRect.width) {
					if (!store.getState().isResizing) setIsResizing(true);
					if (quietTimer) clearTimeout(quietTimer);
					quietTimer = setTimeout(() => {
						setIsResizing(false);
						quietTimer = null;
					}, RESIZE_QUIET_MS);
				}

				// rAF-coalesce the zoom update: any number of ResizeObserver
				// entries that land in the same frame produce one updateZoom.
				if (pendingFrameRef.current !== null) continue;
				pendingFrameRef.current = requestAnimationFrame(() => {
					pendingFrameRef.current = null;
					const containerWidth = latestWidthRef.current;
					if (containerWidth === null) return;
					if (!store.getState().isZoomFitWidth) return;
					const newZoom = getFitWidthZoom(
						containerWidth,
						viewports,
						zoomOptions,
					);
					updateZoom(newZoom, true);
				});
			}
		});

		resizeObserver.observe(viewportRef.current);

		return () => {
			if (quietTimer) clearTimeout(quietTimer);
			resizeObserver.disconnect();
			if (pendingFrameRef.current !== null) {
				cancelAnimationFrame(pendingFrameRef.current);
				pendingFrameRef.current = null;
			}
			// Clear isResizing on unmount — otherwise tearing down mid-drag
			// leaves the store stuck in resizing mode and useCanvasLayer
			// keeps skipping render() for pages that already have a bitmap.
			if (store.getState().isResizing) setIsResizing(false);
		};
	}, [store, updateZoom, setIsResizing, viewportRef, viewports, zoomOptions]);

	return null;
};
