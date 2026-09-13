import {
	observeElementRect as observePhysicalElementRect,
	type Rect,
	type Virtualizer,
} from "@tanstack/react-virtual";

import { PDFStore } from "../../internal";

const supportsScrollend =
	typeof window === "undefined" ? true : "onscrollend" in window;

type ObserveOffsetCallBack = (offset: number, isScrolling: boolean) => void;

const addEventListenerOptions = {
	passive: true,
};

export const useObserveElement = () => {
	const store = PDFStore.useContext();

	// Item measurements and scroll offsets use scale-1 PDF coordinates. Keep
	// the viewport in that same space, including zoom changes without a resize.
	const observeElementRect = <T extends Element>(
		instance: Virtualizer<T, Element>,
		cb: (rect: Rect) => void,
	) => {
		let physicalRect: Rect | undefined;
		const publish = () => {
			if (!physicalRect) return;
			const zoom = store.getState().zoom;
			cb({
				width: physicalRect.width / zoom,
				height: physicalRect.height / zoom,
			});
		};
		const stopObserving = observePhysicalElementRect(instance, (rect) => {
			physicalRect = rect;
			publish();
		});
		const unsubscribe = store.subscribe((state, previous) => {
			if (state.zoom !== previous.zoom) publish();
		});
		return () => {
			stopObserving?.();
			unsubscribe();
		};
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

		let isScrolling = false;
		let idleTimer: number | undefined;
		const needsIdleFallback =
			!instance.options.useScrollendEvent || !supportsScrollend;
		const publish = (scrolling: boolean) => {
			isScrolling = scrolling;
			const { horizontal, isRtl } = instance.options;
			const physicalOffset = horizontal
				? element.scrollLeft * (isRtl ? -1 : 1)
				: element.scrollTop;
			cb(physicalOffset / store.getState().zoom, isScrolling);
		};
		const clearIdleTimer = () => {
			if (idleTimer !== undefined) targetWindow.clearTimeout(idleTimer);
			idleTimer = undefined;
		};
		const createHandler = (scrolling: boolean) => () => {
			clearIdleTimer();
			publish(scrolling);
			if (scrolling && needsIdleFallback) {
				idleTimer = targetWindow.setTimeout(() => {
					idleTimer = undefined;
					publish(false);
				}, instance.options.isScrollingResetDelay);
			}
		};
		const handler = createHandler(true);
		const endHandler = createHandler(false);
		endHandler();
		// A zoom changes the logical offset even if the physical position does
		// not move, or its native scroll event has not arrived yet. Keep the
		// offset in the same coordinate space as the zoom-aware rect observer.
		const unsubscribe = store.subscribe((state, previous) => {
			if (state.zoom !== previous.zoom) publish(isScrolling);
		});

		element.addEventListener("scroll", handler, addEventListenerOptions);
		element.addEventListener("scrollend", endHandler, addEventListenerOptions);

		return () => {
			unsubscribe();
			clearIdleTimer();
			element.removeEventListener("scroll", handler);
			element.removeEventListener("scrollend", endHandler);
		};
	};
	return {
		observeElementRect,
		observeElementOffset,
	};
};
