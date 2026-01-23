import {
	elementScroll,
	type VirtualizerOptions,
} from "@tanstack/react-virtual";
import { useCallback, useRef } from "react";

import { PDFStore } from "../../internal";

const easeInOutSmooth = (t: number): number => {
	t *= 2;
	if (t < 1) {
		return 0.5 * t * t * t;
	}
	t -= 2;
	return 0.5 * (t * t * t + 2);
};

export const useScrollFn = () => {
	const scrollingRef = useRef<number | null>(null);
	const horizontalScrollRef = useRef<number | null>(null);
	const store = PDFStore.useContext();

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const scrollToFn: VirtualizerOptions<any, any>["scrollToFn"] = useCallback(
		(_offset, canSmooth, instance) => {
			const duration = 300;
			const scrollElement = instance.scrollElement;
			const start = scrollElement?.scrollTop || 0;
			const startTime = Date.now();
			scrollingRef.current = startTime;

			const zoom = store.getState().zoom;
			const offset = _offset * zoom;

			// if we are in auto scroll mode, then immediately scroll
			// to the offset and not display any animation. For example if scroll
			// immediately to a rescaled offset if zoom/scale has just been changed
			if (canSmooth.behavior === "auto") {
				elementScroll(offset, canSmooth, instance);
				return;
			}

			// if we are in smooth mode then we scroll using our ease out schedule
			const run = () => {
				if (scrollingRef.current !== startTime) return;
				const now = Date.now();
				const elapsed = now - startTime;
				const progress = easeInOutSmooth(Math.min(elapsed / duration, 1));
				const interpolated = start + (offset - start) * progress;

				if (elapsed < duration) {
					elementScroll(interpolated, { behavior: "auto" }, instance);
					requestAnimationFrame(run);
				} else {
					elementScroll(offset, { behavior: "auto" }, instance);
				}
			};

			requestAnimationFrame(run);
		},
		[store],
	);

	const smoothScrollLeft = useCallback(
		(scrollElement: HTMLElement, targetLeft: number) => {
			const duration = 300;
			const start = scrollElement.scrollLeft;
			const startTime = Date.now();
			horizontalScrollRef.current = startTime;

			const run = () => {
				if (horizontalScrollRef.current !== startTime) return;
				const elapsed = Date.now() - startTime;
				const progress = easeInOutSmooth(Math.min(elapsed / duration, 1));
				const interpolated = start + (targetLeft - start) * progress;

				if (elapsed < duration) {
					scrollElement.scrollLeft = interpolated;
					requestAnimationFrame(run);
				} else {
					scrollElement.scrollLeft = targetLeft;
				}
			};

			requestAnimationFrame(run);
		},
		[],
	);

	return { scrollToFn, smoothScrollLeft };
};
