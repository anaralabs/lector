import type { VirtualItem } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";

import { PDFStore } from "../../internal";

interface UseVisiblePageProps {
	items: VirtualItem[];
}

export const useVisiblePage = ({ items }: UseVisiblePageProps) => {
	const store = PDFStore.useContext();
	const lastPageRef = useRef(0);
	// Keep a stable ref to the latest items so the scroll listener always
	// sees fresh data without needing to re-subscribe.
	const itemsRef = useRef(items);
	itemsRef.current = items;

	useEffect(() => {
		const { viewportRef } = store.getState();
		const scrollEl = viewportRef?.current;
		if (!scrollEl) return;

		const handleScroll = () => {
			const state = store.getState();
			if (state.isPinching) return;

			const currentItems = itemsRef.current;
			if (currentItems.length === 0) return;

			const zoom = state.zoom;
			const scrollTop = scrollEl.scrollTop / zoom;
			const viewportHeight = scrollEl.clientHeight / zoom;
			const viewportCenter = scrollTop + viewportHeight / 2;

			let closestIndex = 0;
			let smallestDistance = Infinity;

			for (const item of currentItems) {
				const itemCenter = item.start + item.size / 2;
				const distance = Math.abs(itemCenter - viewportCenter);

				// 20% hysteresis threshold to prevent rapid switching near boundaries
				if (distance < smallestDistance * 0.8) {
					smallestDistance = distance;
					closestIndex = item.index;
				}
			}

			const page = closestIndex + 1;
			if (page !== lastPageRef.current) {
				lastPageRef.current = page;
				state.setCurrentPage(page);
			}
		};

		// Run once immediately to set the initial page
		handleScroll();

		scrollEl.addEventListener("scroll", handleScroll, { passive: true });
		return () => {
			scrollEl.removeEventListener("scroll", handleScroll);
		};
		// Re-attach only when the scroll container changes (rare) — items are
		// read from itemsRef so this listener is always up-to-date without
		// re-running on every scroll frame.
	}, [store]);

	return null;
};
