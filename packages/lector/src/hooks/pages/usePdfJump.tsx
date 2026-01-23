import { useCallback } from "react";
import { type HighlightRect, PDFStore, usePdf } from "../../internal";

export const usePdfJump = () => {
	const virtualizer = usePdf((state) => state.virtualizer);
	const setHighlight = usePdf((state) => state.setHighlight);
	const store = PDFStore.useContext();

	const jumpToPage = useCallback(
		(
			pageIndex: number,
			options?: {
				align?: "start" | "center" | "end" | "auto";
				behavior?: "auto" | "smooth";
			},
		) => {
			if (!virtualizer) return;

			// Define default options
			const defaultOptions = {
				align: "start",
				behavior: "smooth",
			};

			// Merge default options with any provided options

			const finalOptions = { ...defaultOptions, ...options };
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			virtualizer.scrollToIndex(pageIndex - 1, finalOptions as any);
		},
		[virtualizer],
	);

	const jumpToOffset = useCallback(
		(offset: number) => {
			if (!virtualizer) return;
			virtualizer.scrollToOffset(offset, {
				align: "start",
				behavior: "smooth",
			});
		},
		[virtualizer],
	);

	const scrollToHighlightRects = useCallback(
		(
			rects: HighlightRect[],
			type: "pixels" | "percent",
			align: "start" | "center" = "start",
			additionalOffset: number = 0,
		) => {
			if (!virtualizer) return;
			if (rects.length === 0) return;

			const zoom = store.getState().zoom;

			if (zoom === null || zoom <= 0) return;

			const firstPage = Math.min(...rects.map((rect) => rect.pageNumber));

			// Get the start offset of the page in the viewport
			const pageOffset = virtualizer.getOffsetForIndex(firstPage - 1, "start");

			if (pageOffset === null) return;

			// Find the target highlight rect (usually the first one)
			const targetRect = rects.find((rect) => rect.pageNumber === firstPage);

			if (!targetRect) return;

			const isNumber = pageOffset?.[0] != null;
			if (!isNumber) return;

			const pageStart = pageOffset[0] ?? 0;

			// Calculate the rect position and dimensions
			let rectTop: number;
			let rectHeight: number;
			let rectLeft: number;
			let rectWidth: number;

			if (type === "percent") {
				const pageViewport = store.getState().viewports[firstPage - 1];
				if (!pageViewport) return;
				rectTop = (targetRect.top / 100) * pageViewport.height;
				rectHeight = (targetRect.height / 100) * pageViewport.height;
				rectLeft = (targetRect.left / 100) * pageViewport.width;
				rectWidth = (targetRect.width / 100) * pageViewport.width;
			} else {
				rectTop = targetRect.top;
				rectHeight = targetRect.height;
				rectLeft = targetRect.left;
				rectWidth = targetRect.width;
			}

			// Calculate the scroll offset based on alignment
			let scrollOffset: number;
			let scrollLeftOffset: number | null = null;

			if (align === "center") {
				// When centering in the viewport, we need the viewport dimensions
				// Divide by zoom to convert screen pixels to document coordinates
				const viewportHeight =
					(virtualizer.scrollElement?.clientHeight || 0) / zoom;
				const viewportWidth =
					(virtualizer.scrollElement?.clientWidth || 0) / zoom;

				// Vertical centering: rect's center minus half the viewport height
				const rectCenterY = pageStart + rectTop + rectHeight / 2;
				scrollOffset = rectCenterY - viewportHeight / 2;

				// Horizontal centering: rect's center minus half the viewport width
				const rectCenterX = rectLeft + rectWidth / 2;
				scrollLeftOffset = rectCenterX - viewportWidth / 2;
			} else {
				// Use the top of the highlight rect
				scrollOffset = pageStart + rectTop;
			}

			// Apply the additional offset (convert from screen pixels to PDF space)
			// This ensures additionalOffset remains constant in screen space regardless of zoom
			scrollOffset += additionalOffset / zoom;

			// Ensure we don't scroll to a negative offset
			const adjustedOffset = Math.max(0, scrollOffset);

			virtualizer.scrollToOffset(adjustedOffset, {
				align: "start",
				behavior: "smooth",
			});

			// Apply horizontal scroll if needed (virtualizer only handles vertical)
			if (scrollLeftOffset !== null && virtualizer.scrollElement) {
				const adjustedScrollLeft = Math.max(0, scrollLeftOffset * zoom);
				virtualizer.scrollElement.scrollLeft = adjustedScrollLeft;
			}
		},
		[virtualizer, store],
	);

	const jumpToHighlightRects = useCallback(
		(
			rects: HighlightRect[],
			type: "pixels" | "percent",
			align: "start" | "center" = "start",
			additionalOffset: number = 0,
		) => {
			if (!virtualizer) return;

			setHighlight(rects);

			scrollToHighlightRects(rects, type, align, additionalOffset);
		},
		[virtualizer, setHighlight, scrollToHighlightRects],
	);

	return {
		jumpToPage,
		jumpToOffset,
		jumpToHighlightRects,
		scrollToHighlightRects,
	};
};
