import { debounce, type Virtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";

import { PDFStore } from "../../internal";
import { notifyScrollActivity } from "../../lib/scroll-activity";

const supportsScrollend =
	typeof window === "undefined" ? true : "onscrollend" in window;

type ObserveOffsetCallBack = (offset: number, isScrolling: boolean) => void;
type OffsetListener = (offset: number) => void;

const addEventListenerOptions = {
	passive: true,
};

export interface ObserveElementController {
	addOffsetListener: (fn: OffsetListener) => () => void;
}

export const useObserveElement = () => {
	const store = PDFStore.useContext();
	// Consumer-facing scroll listeners are invoked from the same rAF that
	// drives the virtualizer. Lives in a ref so the observer closure below
	// always sees the current listener set without re-subscribing.
	const offsetListenersRef = useRef<Set<OffsetListener>>(new Set());

	const controller: ObserveElementController = {
		addOffsetListener: (fn) => {
			offsetListenersRef.current.add(fn);
			return () => {
				offsetListenersRef.current.delete(fn);
			};
		},
	};

	const observeElementOffset = <T extends Element>(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		instance: Virtualizer<T, any>,
		cb: ObserveOffsetCallBack,
	) => {
		const element = instance.scrollElement;
		if (!element) {
			return;
		}
		const targetWindow = instance.targetWindow;
		if (!targetWindow) {
			return;
		}

		let offset = 0;
		let rafId: number | null = null;
		let pendingIsScrolling = true;
		let latestRawOffset = 0;

		const fallback =
			instance.options.useScrollendEvent && supportsScrollend
				? () => undefined
				: debounce(
						targetWindow,
						() => {
							cb(offset, false);
						},
						instance.options.isScrollingResetDelay,
					);

		const flush = () => {
			rafId = null;
			const zoom = store.getState().zoom;
			const next = latestRawOffset / zoom;
			offset = next;
			fallback();
			if (pendingIsScrolling) {
				notifyScrollActivity();
			}
			cb(next, pendingIsScrolling);
			// Notify consumer listeners (e.g. scroll-position persistence)
			// in the same rAF instead of requiring a React re-render.
			const listeners = offsetListenersRef.current;
			if (listeners.size) {
				listeners.forEach((fn) => fn(next));
			}
		};

		const schedule = (isScrolling: boolean) => {
			const { horizontal, isRtl } = instance.options;
			latestRawOffset = horizontal
				? element.scrollLeft * ((isRtl && -1) || 1)
				: element.scrollTop;
			pendingIsScrolling = isScrolling;
			if (rafId !== null) return;
			rafId = targetWindow.requestAnimationFrame(flush);
		};

		const handler = () => schedule(true);
		const endHandler = () => {
			if (rafId !== null) {
				targetWindow.cancelAnimationFrame(rafId);
				rafId = null;
			}
			const { horizontal, isRtl } = instance.options;
			latestRawOffset = horizontal
				? element.scrollLeft * ((isRtl && -1) || 1)
				: element.scrollTop;
			pendingIsScrolling = false;
			// Run synchronously on scrollend so resting state is accurate.
			flush();
		};
		// Initial snapshot.
		endHandler();

		element.addEventListener("scroll", handler, addEventListenerOptions);
		element.addEventListener("scrollend", endHandler, addEventListenerOptions);

		return () => {
			if (rafId !== null) {
				targetWindow.cancelAnimationFrame(rafId);
				rafId = null;
			}
			element.removeEventListener("scroll", handler);
			element.removeEventListener("scrollend", endHandler);
		};
	};
	return {
		observeElementOffset,
		controller,
	};
};
