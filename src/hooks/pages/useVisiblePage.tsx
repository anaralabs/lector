import type { VirtualItem } from "@tanstack/react-virtual";
import { useCallback, useEffect } from "react";

import { usePdf } from "../../internal";

interface UseVisiblePageProps {
	items: VirtualItem[];
}

export const useVisiblePage = ({ items }: UseVisiblePageProps) => {
	const zoomLevel = usePdf((state) => state.zoom);
	const isPinching = usePdf((state) => state.isPinching);
	const setCurrentPage = usePdf((state) => state.setCurrentPage);
	const scrollElement = usePdf((state) => state.viewportRef?.current);

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

			setCurrentPage?.(mostVisibleIndex + 1);
		}
	}, [items, isPinching, calculateVisiblePageIndex, setCurrentPage]);

	return null;
};
