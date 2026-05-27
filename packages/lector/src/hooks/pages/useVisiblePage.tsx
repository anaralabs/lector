import type { VirtualItem } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef } from "react";

import { usePdf } from "../../internal";

interface UseVisiblePageProps {
	items: VirtualItem[];
	/**
	 * The virtualizer's tracked scroll offset (px). Passed in so we never read
	 * `scrollElement.scrollTop` here — reading layout in this per-scroll effect
	 * forces a synchronous reflow on every frame, which is pathologically
	 * expensive under large stylesheets (e.g. Tailwind v4's registered
	 * @property custom properties amplify forced style-recalc ~8x).
	 */
	scrollOffset: number;
}

export const useVisiblePage = ({
	items,
	scrollOffset,
}: UseVisiblePageProps) => {
	const zoomLevel = usePdf((state) => state.zoom);
	const isPinching = usePdf((state) => state.isPinching);
	const setCurrentPage = usePdf((state) => state.setCurrentPage);
	const scrollElement = usePdf((state) => state.viewportRef?.current);

	const lastPageRef = useRef(0);

	// Cache the viewport height — it only changes on resize, so reading
	// `clientHeight` on every scroll would force a layout reflow each frame.
	const viewportHeightRef = useRef(0);
	useEffect(() => {
		if (!scrollElement) return;
		viewportHeightRef.current = scrollElement.clientHeight;
		const observer = new ResizeObserver(() => {
			viewportHeightRef.current = scrollElement.clientHeight;
		});
		observer.observe(scrollElement);
		return () => observer.disconnect();
	}, [scrollElement]);

	const calculateVisiblePageIndex = useCallback(
		(virtualItems: VirtualItem[]) => {
			if (virtualItems.length === 0) return 0;

			// Derive everything from cached/virtualizer values — no DOM layout
			// reads, so this never forces a reflow during scroll.
			const scrollTop = scrollOffset / zoomLevel;
			const viewportHeight = viewportHeightRef.current / zoomLevel;
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
		[scrollOffset, zoomLevel],
	);

	useEffect(() => {
		if (!isPinching && items.length > 0) {
			const mostVisibleIndex = calculateVisiblePageIndex(items);
			const page = mostVisibleIndex + 1;

			// Skip the state update if the page hasn't actually changed
			if (page !== lastPageRef.current) {
				lastPageRef.current = page;
				setCurrentPage?.(page);
			}
		}
	}, [items, isPinching, calculateVisiblePageIndex, setCurrentPage]);

	return null;
};
