import type React from "react";
import { useLayoutEffect } from "react";

import { PDFStore } from "../../internal";
import { getFitWidthZoom } from "../../lib/zoom";

interface UseFitWidth {
	viewportRef: React.RefObject<HTMLDivElement | null>;
}
export const useFitWidth = ({ viewportRef }: UseFitWidth) => {
	const store = PDFStore.useContext();

	useLayoutEffect(() => {
		if (viewportRef.current === null) return;

		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				if (entry.target !== viewportRef.current) continue;

				// Read store imperatively — avoids adding viewports/zoomOptions to
				// the effect deps, which would reconnect the observer on every lazy
				// page proxy load (viewports array is replaced each time).
				const { isZoomFitWidth, viewports, zoomOptions, updateZoom } =
					store.getState();
				if (!isZoomFitWidth) continue;

				const newZoom = getFitWidthZoom(
					entry.contentRect.width,
					viewports,
					zoomOptions,
				);
				updateZoom(newZoom, true);
			}
		});

		resizeObserver.observe(viewportRef.current);

		return () => {
			resizeObserver.disconnect();
		};
		// Only re-run when the container element or store reference changes —
		// never for viewports/zoomOptions churn.
	}, [store, viewportRef]);

	return null;
};
