import { useEffect, useRef } from "react";

import { usePdf } from "../../internal";
import { bindTextSelection } from "../../lib/text-selection";
import { usePDFPageNumber } from "../usePdfPageNumber";

export const useTextLayer = () => {
	const textContainerRef = useRef<HTMLDivElement>(null);
	const textLayerRef = useRef<{
		cancel: () => void;
		render: () => Promise<void>;
	} | null>(null);
	const isRenderingRef = useRef(false);

	const pageNumber = usePDFPageNumber();
	const viewportRef = usePdf((state) => state.viewportRef);
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));

	useEffect(() => {
		const textContainer = textContainerRef.current;
		if (!textContainer || isRenderingRef.current) {
			return;
		}

		let isCancelled = false;
		let cleanupSelection: (() => void) | undefined;

		isRenderingRef.current = true;

		textContainer.innerHTML = "";

		if (textLayerRef.current) {
			textLayerRef.current.cancel();
			textLayerRef.current = null;
		}

		void import("pdfjs-dist/legacy/build/pdf.mjs")
			.then(({ TextLayer }) => {
				if (isCancelled || textContainerRef.current !== textContainer) return;

				const textLayer = new TextLayer({
					textContentSource: pdfPageProxy.streamTextContent(),
					container: textContainer,
					viewport: pdfPageProxy.getViewport({ scale: 1 }),
				});

				textLayerRef.current = textLayer;

				return textLayer.render();
			})
			.then(() => {
				if (isCancelled || textContainerRef.current !== textContainer) {
					return;
				}

				cleanupSelection = bindTextSelection(textContainer, viewportRef);
			})
			.catch((error) => {
				if (error instanceof Error && error.name !== "AbortException") {
					console.error("TextLayer rendering error:", error);
				}
			})
			.finally(() => {
				isRenderingRef.current = false;
			});

		return () => {
			isCancelled = true;
			isRenderingRef.current = false;

			if (textLayerRef.current) {
				textLayerRef.current.cancel();
				textLayerRef.current = null;
			}

			cleanupSelection?.();
		};
	}, [pdfPageProxy, viewportRef]);

	return {
		textContainerRef,
		pageNumber: pdfPageProxy.pageNumber,
	};
};
