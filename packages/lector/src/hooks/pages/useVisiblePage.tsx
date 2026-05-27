import type { VirtualItem } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, useState } from "react";

import { usePdf } from "../../internal";

interface UseVisiblePageProps {
	items: VirtualItem[];
	/**
	 * The virtualizer's tracked scroll offset (px). Passed in so we never read
	 * `scrollElement.scrollTop` here — reading layout in this per-scroll effect
	 * forces a synchronous reflow on every frame, which is pathologically
	 * expensive under large stylesheets (e.g. Tailwind v4's registered
	 * @property custom properties amplify forced style-recalc ~8x).
	 * Null before the virtualizer has measured its offset — page detection is
	 * skipped until then so we never publish a stale top-of-document page.
	 */
	scrollOffset: number | null;
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

	// Track viewport height in state — it only changes on resize (and when the
	// scroll element first attaches), never on scroll, so the per-scroll path
	// stays free of `clientHeight` reads (which would force a reflow each
	// frame), while a resize still re-runs page detection below (it feeds
	// `calculateVisiblePageIndex`'s deps).
	const [viewportHeight, setViewportHeight] = useState(0);
	useEffect(() => {
		if (!scrollElement) return;
		const measure = () => setViewportHeight(scrollElement.clientHeight);
		measure();
		// Prefer ResizeObserver (catches container resizes, not just window
		// ones); fall back to window `resize` where it's unavailable (older
		// embedded browsers / jsdom consumer tests) so the height still updates.
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", measure);
			return () => window.removeEventListener("resize", measure);
		}
		const observer = new ResizeObserver(measure);
		observer.observe(scrollElement);
		return () => observer.disconnect();
	}, [scrollElement]);

	const calculateVisiblePageIndex = useCallback(
		(virtualItems: VirtualItem[]) => {
			if (virtualItems.length === 0 || scrollOffset == null) return 0;

			// Derive everything from cached/virtualizer values — no DOM layout
			// reads, so this never forces a reflow during scroll. `scrollOffset`
			// is already zoom-normalized by the virtualizer (useObserveElement
			// divides scrollTop by zoom), and item start/size live in that same
			// unzoomed space — so only the raw viewport height needs dividing.
			const viewportCenter = scrollOffset + viewportHeight / zoomLevel / 2;

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
		[scrollOffset, zoomLevel, viewportHeight],
	);

	useEffect(() => {
		// Self-heal a stale 0 height: if the element now has a real height but
		// our cached value is still 0 (e.g. mounted hidden in a tab/accordion in
		// an environment without ResizeObserver, then shown without a window
		// resize), pick it up here. Gated on `=== 0`, so steady-state scrolling
		// never reads layout — no reflow on the hot path.
		if (viewportHeight === 0 && scrollElement) {
			const h = scrollElement.clientHeight;
			if (h > 0) {
				setViewportHeight(h);
				return;
			}
		}

		// Wait for a real viewport height before publishing — at height 0 the
		// center collapses to the viewport top, which can briefly report the
		// wrong page on mount or a restored/deep-linked scroll position.
		if (
			!isPinching &&
			items.length > 0 &&
			viewportHeight > 0 &&
			scrollOffset != null
		) {
			const mostVisibleIndex = calculateVisiblePageIndex(items);
			const page = mostVisibleIndex + 1;

			// Skip the state update if the page hasn't actually changed
			if (page !== lastPageRef.current) {
				lastPageRef.current = page;
				setCurrentPage?.(page);
			}
		}
	}, [
		items,
		isPinching,
		calculateVisiblePageIndex,
		setCurrentPage,
		viewportHeight,
		scrollOffset,
		scrollElement,
	]);

	return null;
};
