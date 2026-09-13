import { act, cleanup, render, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useDpr } from "../src/hooks/useDpr";
import { useVisibility } from "../src/hooks/useVisibility";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test("100 thumbnail consumers share visibility and DPR observers", () => {
	const media = vi.spyOn(window, "matchMedia");
	const OriginalObserver = window.IntersectionObserver;
	const intersection = vi
		.spyOn(window, "IntersectionObserver")
		.mockImplementation(function (callback, options) {
			if (!new.target) throw new TypeError("IntersectionObserver requires new");
			return new OriginalObserver(callback, options);
		});
	function Consumer() {
		const ref = useRef<HTMLDivElement>(null);
		useDpr();
		useVisibility({ elementRef: ref });
		return <div ref={ref} />;
	}
	const ids = Array.from({ length: 100 }, (_, id) => id);
	render(ids.map((id) => <Consumer key={id} />));
	console.info(
		`PERF 100-thumbnail-observers: media=${media.mock.calls.length}, intersection=${intersection.mock.calls.length}`,
	);
	expect(media).toHaveBeenCalledTimes(1);
	expect(intersection).toHaveBeenCalledTimes(1);
});

test("shared DPR subscription follows increases, decreases and releases its listener", () => {
	vi.stubGlobal("devicePixelRatio", 1);
	const queries: string[] = [];
	const media: Array<{
		target: EventTarget;
		remove: ReturnType<typeof vi.fn>;
	}> = [];
	vi.spyOn(window, "matchMedia").mockImplementation((query) => {
		queries.push(query);
		const target = new EventTarget();
		const remove = vi.fn(target.removeEventListener.bind(target));
		media.push({ target, remove });
		return {
			addEventListener: target.addEventListener.bind(target),
			removeEventListener: remove,
		} as unknown as MediaQueryList;
	});
	const { result, unmount } = renderHook(useDpr);
	expect(result.current).toBe(1);
	for (const [actual, expected] of [
		[1.5, 1.5],
		[3, 3],
		[1, 1],
	]) {
		act(() => {
			vi.stubGlobal("devicePixelRatio", actual);
			media.at(-1)!.target.dispatchEvent(new Event("change"));
		});
		expect(result.current).toBe(expected);
	}
	expect(queries).toEqual([
		"(resolution: 1dppx), (-webkit-device-pixel-ratio: 1)",
		"(resolution: 1.5dppx), (-webkit-device-pixel-ratio: 1.5)",
		"(resolution: 3dppx), (-webkit-device-pixel-ratio: 3)",
		"(resolution: 1dppx), (-webkit-device-pixel-ratio: 1)",
	]);
	unmount();
	expect(media.at(-1)!.remove).toHaveBeenCalledTimes(1);
});

test("visibility subscribers on the same element share updates and clean up independently", () => {
	let callback!: IntersectionObserverCallback;
	const observe = vi.fn(),
		unobserve = vi.fn(),
		disconnect = vi.fn();
	vi.spyOn(window, "IntersectionObserver").mockImplementation(
		class implements IntersectionObserver {
			root = null;
			rootMargin = "0px";
			thresholds = [0];
			observe = observe;
			unobserve = unobserve;
			disconnect = disconnect;
			constructor(cb: IntersectionObserverCallback) {
				callback = cb;
			}
			takeRecords(): IntersectionObserverEntry[] {
				return [];
			}
		},
	);
	const elementRef = { current: document.createElement("div") };
	const first = renderHook(() => useVisibility({ elementRef }));
	act(() =>
		callback(
			[
				{
					target: elementRef.current,
					isIntersecting: true,
					intersectionRatio: 1,
					time: 0,
					rootBounds: null,
					boundingClientRect: new DOMRect(),
					intersectionRect: new DOMRect(),
				},
			],
			{} as IntersectionObserver,
		),
	);
	expect(first.result.current.visible).toBe(true);
	const second = renderHook(() => useVisibility({ elementRef }));
	expect(second.result.current.visible).toBe(true);
	expect(observe).toHaveBeenCalledTimes(1);
	first.unmount();
	expect(unobserve).not.toHaveBeenCalled();
	act(() =>
		callback(
			[
				{
					target: elementRef.current,
					isIntersecting: false,
					intersectionRatio: 0,
					time: 0,
					rootBounds: null,
					boundingClientRect: new DOMRect(),
					intersectionRect: new DOMRect(),
				},
			],
			{} as IntersectionObserver,
		),
	);
	expect(second.result.current.visible).toBe(false);
	second.unmount();
	expect(unobserve).toHaveBeenCalledTimes(1);
	expect(disconnect).toHaveBeenCalledTimes(1);
});
