import type React from "react";
import { useLayoutEffect } from "react";

import { PDFStore, usePdf } from "../../internal";
import { getFitWidthZoom } from "../../lib/zoom";

interface UseFitWidth {
	viewportRef: React.RefObject<HTMLDivElement | null>;
}
export const useFitWidth = ({ viewportRef }: UseFitWidth) => {
	const viewports = usePdf((state) => state.viewports);
	const zoomOptions = usePdf((state) => state.zoomOptions);

	const updateZoom = usePdf((state) => state.updateZoom);
	const store = PDFStore.useContext();

	useLayoutEffect(() => {
		if (viewportRef.current === null) return;
		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const isFitWidth = store.getState().isZoomFitWidth;

				if (entry.target === viewportRef.current && isFitWidth) {
					const containerWidth = entry.contentRect.width;
					const newZoom = getFitWidthZoom(
						containerWidth,
						viewports,
						zoomOptions,
					);
					updateZoom(newZoom, true);
				}
			}
		});

		resizeObserver.observe(viewportRef.current);

		return () => {
			resizeObserver.disconnect();
		};
	}, [store, updateZoom, viewportRef, viewports, zoomOptions]);

	return null;
};
