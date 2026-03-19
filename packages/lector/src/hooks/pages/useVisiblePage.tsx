import type { VirtualItem } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef } from "react";

import { usePdf } from "../../internal";

interface UseVisiblePageProps {
	items: VirtualItem[];
}

export const useVisiblePage = ({ items }: UseVisiblePageProps) => {
	const zoomLevel = usePdf((state) => state.zoom);
	const isPinching = usePdf((state) => state.isPinching);
	const setCurrentPage = usePdf((state) => state.setCurrentPage);
	const scrollElement = usePdf((state) => state.viewportRef?.current);

	// Cache clientHeight to avoid forced reflow when virtualizer
	// dirties layout by adding/removing page elements.
	const cachedHeightRef = useRef(0);

	useEffect(() => {
		if (!scrollElement) return;
		cachedHeightRef.current = scrollElement.clientHeight;

		const observer = new ResizeObserver(() => {
			cachedHeightRef.current = scrollElement.clientHeight;
		});
		observer.observe(scrollElement);
		return () => observer.disconnect();
	}, [scrollElement]);

	const calculateVisiblePageIndex = useCallback(
		(virtualItems: VirtualItem[]) => {
			if (!scrollElement || virtualItems.length === 0) return 0;

			const scrollTop = scrollElement.scrollTop / zoomLevel;
			const viewportHeight = cachedHeightRef.current / zoomLevel;
			const viewportCenter = scrollTop + viewportHeight / 2;

			let closestIndex = 0;
			let smallestDistance = Infinity;

			for (const item of virtualItems) {
				const itemCenter = item.start + item.size / 2;
				const distance = Math.abs(itemCenter - viewportCenter);

				if (distance < smallestDistance * 0.8) {
					smallestDistance = distance;
					closestIndex = item.index;
				}
			}

			return closestIndex;
		},
		[scrollElement, zoomLevel],
	);

	const rafRef = useRef(0);

	useEffect(() => {
		cancelAnimationFrame(rafRef.current);
		if (!isPinching && items.length > 0) {
			rafRef.current = requestAnimationFrame(() => {
				const mostVisibleIndex = calculateVisiblePageIndex(items);
				setCurrentPage?.(mostVisibleIndex + 1);
			});
		}
		return () => cancelAnimationFrame(rafRef.current);
	}, [items, isPinching, calculateVisiblePageIndex, setCurrentPage]);

	return null;
};
