import { debounce, type Virtualizer } from "@tanstack/react-virtual";

import { PDFStore } from "../../internal";

const supportsScrollend =
	typeof window === "undefined" ? true : "onscrollend" in window;

type ObserveOffsetCallBack = (offset: number, isScrolling: boolean) => void;

const addEventListenerOptions = {
	passive: true,
};

export const useObserveElement = () => {
	const store = PDFStore.useContext();

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

		const createHandler = (isScrolling: boolean) => () => {
			const { horizontal, isRtl } = instance.options;
			offset = horizontal
				? element.scrollLeft * ((isRtl && -1) || 1)
				: element.scrollTop;

			const zoom = store.getState().zoom;
			offset = offset / zoom;
			fallback();

			cb(offset, isScrolling);
		};
		const handler = createHandler(true);
		const endHandler = createHandler(false);
		endHandler();

		element.addEventListener("scroll", handler, addEventListenerOptions);
		element.addEventListener("scrollend", endHandler, addEventListenerOptions);

		return () => {
			element.removeEventListener("scroll", handler);
			element.removeEventListener("scrollend", endHandler);
		};
	};
	return {
		observeElementOffset,
	};
};
