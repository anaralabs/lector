import type { VirtualItem } from "@tanstack/react-virtual";
import { startTransition, useCallback, useEffect, useRef } from "react";

import { usePdf } from "../../internal";

interface UseVisiblePageProps {
	items: VirtualItem[];
}

export const useVisiblePage = ({ items }: UseVisiblePageProps) => {
	const zoomLevel = usePdf((state) => state.zoom);
	const isPinching = usePdf((state) => state.isPinching);
	const setCurrentPage = usePdf((state) => state.setCurrentPage);
	const scrollElement = usePdf((state) => state.viewportRef?.current);

	const lastPageRef = useRef(0);

	const calculateVisiblePageIndex = useCallback(
		(virtualItems: VirtualItem[]) => {
			if (!scrollElement || virtualItems.length === 0) return 0;

			const scrollTop = scrollElement.scrollTop / zoomLevel;
			const viewportHeight = scrollElement.clientHeight / zoomLevel;
			const viewportCenter = scrollTop + viewportHeight / 2;

			// Find the page whose center is closest to viewport center
			let closestIndex = 0;
			let smallestDistance = Infinity;

			for (const item of virtualItems) {
				const itemCenter = item.start + item.size / 2;
				const distance = Math.abs(itemCenter - viewportCenter);

				// Add a 20% threshold to prevent frequent switches
				if (distance < smallestDistance * 0.8) {
					smallestDistance = distance;
					closestIndex = item.index;
				}
			}

			return closestIndex;
		},
		[scrollElement, zoomLevel],
	);

	useEffect(() => {
		if (!isPinching && items.length > 0) {
			const mostVisibleIndex = calculateVisiblePageIndex(items);
			const page = mostVisibleIndex + 1;

			// Skip the state update if the page hasn't actually changed
			if (page !== lastPageRef.current) {
				lastPageRef.current = page;
				// `currentPage` is typically consumed by non-critical UI (page
				// indicator, thumbnails) — allow React to interrupt if a more
				// urgent update (scroll/zoom) comes in mid-commit.
				startTransition(() => {
					setCurrentPage?.(page);
				});
			}
		}
	}, [items, isPinching, calculateVisiblePageIndex, setCurrentPage]);

	return null;
};
