import type { Virtualizer } from "@tanstack/react-virtual";
import { renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { useObserveElement } from "./useObserveElement";

const store = createStore(() => ({ zoom: 1 }));
vi.mock("../../internal", () => ({
	PDFStore: { useContext: () => store },
}));
afterEach(() => {
	vi.useRealTimers();
	store.setState({ zoom: 1 });
});

function observe(horizontal = false, isRtl = false) {
	const element = document.createElement("div");
	// Control physical position independently of native scroll-event delivery.
	Object.defineProperty(element, "scrollTop", { value: 800, writable: true });
	Object.defineProperty(element, "scrollLeft", {
		value: isRtl ? -800 : 800,
		writable: true,
	});
	const instance = {
		scrollElement: element,
		targetWindow: window,
		options: {
			horizontal,
			isRtl,
			useScrollendEvent: false,
			isScrollingResetDelay: 100,
		},
	} as unknown as Virtualizer<HTMLDivElement, Element>;
	const callback = vi.fn();
	const hook = renderHook(useObserveElement);
	const stop = hook.result.current.observeElementOffset(instance, callback)!;
	return {
		element,
		callback,
		stop: () => {
			stop();
			hook.unmount();
		},
	};
}

test.each([
	[false, false],
	[true, false],
	[true, true],
])(
	"renormalizes unchanged physical offset on zoom (horizontal=%s, rtl=%s)",
	(horizontal, rtl) => {
		vi.useFakeTimers();
		const { callback, stop } = observe(horizontal, rtl);
		try {
			expect(callback).toHaveBeenLastCalledWith(800, false);
			store.setState({ zoom: 2 });
			expect(callback).toHaveBeenLastCalledWith(400, false);
			store.setState({ zoom: 0.5 });
			expect(callback).toHaveBeenLastCalledWith(1600, false);
		} finally {
			stop();
		}
	},
);

test("corrects an offset observed before zoom and preserves scrolling until idle", () => {
	vi.useFakeTimers();
	const { element, callback, stop } = observe();
	try {
		element.scrollTop = 1200;
		element.dispatchEvent(new Event("scroll"));
		expect(callback).toHaveBeenLastCalledWith(1200, true);
		store.setState({ zoom: 2 });
		expect(callback).toHaveBeenLastCalledWith(600, true);
		vi.advanceTimersByTime(100);
		expect(callback).toHaveBeenLastCalledWith(600, false);
	} finally {
		stop();
	}
});

test("disposed offset observers ignore zoom changes and pending idle callbacks", () => {
	vi.useFakeTimers();
	const { element, callback, stop } = observe();
	element.dispatchEvent(new Event("scroll"));
	stop();
	callback.mockClear();
	store.setState({ zoom: 2 });
	vi.advanceTimersByTime(100);
	expect(callback).not.toHaveBeenCalled();
});
