import { act, cleanup, renderHook } from "@testing-library/react";
import { useGesture } from "@use-gesture/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewportContainer } from "./useViewportContainer";

const { state, store } = vi.hoisted(() => {
	const state = {
		zoom: 5,
		isPinching: false,
		zoomOptions: { minZoom: 0.2, maxZoom: 5 },
		viewportRef: { current: null as HTMLDivElement | null },
		setIsPinching: vi.fn(),
		updateZoom: vi.fn(),
	};
	return { state, store: { getState: () => state } };
});
vi.mock("@use-gesture/react", () => ({ useGesture: vi.fn() }));
vi.mock("../../lib/zoom", () => ({ USE_LAYOUT_ZOOM: true }));
vi.mock("../../internal", () => ({
	PDFStore: { useContext: () => store },
	usePdf: (selector: (value: typeof state) => unknown) => selector(state),
}));

function fixture() {
	const container = document.createElement("div");
	const wrapper = document.createElement("div");
	const element = document.createElement("div");
	container.style.cssText = "width:300px;height:300px;overflow:auto";
	element.style.cssText = "width:600px;height:800px;position:absolute";
	wrapper.style.cssText = "width:600px;height:800px;position:relative";
	wrapper.append(element);
	container.append(wrapper);
	document.body.append(container);
	const refs = {
		containerRef: { current: container },
		elementWrapperRef: { current: wrapper },
		elementRef: { current: element },
	};
	return { container, wrapper, element, refs };
}

describe("WebKit viewport scaling", () => {
	beforeEach(() => {
		state.zoom = 5;
		state.isPinching = false;
		state.viewportRef.current = null;
		vi.clearAllMocks();
		state.setIsPinching.mockImplementation((value: boolean) => {
			state.isPinching = value;
		});
	});
	afterEach(() => {
		cleanup();
		document.body.replaceChildren();
	});

	it("applies restored zoom on mount, transforms during the gesture, and settles sharply", () => {
		const { element, wrapper, refs } = fixture();
		const { rerender } = renderHook(() => useViewportContainer(refs));
		expect(element.style.zoom).toBe("5");
		expect(element.style.transform).toBe("none");
		expect(wrapper.style.width).toBe("3000px");

		state.isPinching = true;
		rerender();
		state.zoom = 4;
		rerender();
		expect(element.style.zoom).toBe("5");
		expect(element.style.transform).toBe("scale3d(0.8, 0.8, 1)");
		expect(wrapper.style.width).toBe("2400px");

		state.isPinching = false;
		rerender();
		expect(element.style.zoom).toBe("4");
		expect(element.style.transform).toBe("none");
		expect(element.style.willChange).toBe("auto");
	});

	it("keeps a native scroll position when a pinch ends without changing zoom", () => {
		const { container, refs } = fixture();
		const { rerender } = renderHook(() => useViewportContainer(refs));
		container.scrollTop = 500;
		container.scrollLeft = 200;
		state.isPinching = true;
		rerender();
		state.isPinching = false;
		rerender();
		expect(container.scrollTop).toBe(500);
		expect(container.scrollLeft).toBe(200);
	});
});

describe("gesture frame scheduling", () => {
	afterEach(() => {
		cleanup();
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});
	function setup() {
		state.zoom = 1;
		state.isPinching = false;
		state.setIsPinching.mockImplementation((value: boolean) => {
			state.isPinching = value;
		});
		state.updateZoom.mockClear();
		const fixtureState = fixture();
		const hook = renderHook(() => useViewportContainer(fixtureState.refs));
		const handlers = vi.mocked(useGesture).mock.calls.at(-1)![0];
		handlers.onPinchStart!({} as never);
		const first = {
			first: true,
			origin: [150, 150],
			movement: [1, 0],
			delta: [0, 0],
			event: {},
			memo: undefined,
		};
		const memo = handlers.onPinch!(first as never);
		return {
			...fixtureState,
			rerender: hook.rerender,
			handlers,
			move: (scale: number) =>
				handlers.onPinch!({
					...first,
					first: false,
					memo,
					movement: [scale, 0],
				} as never),
		};
	}
	it("applies a burst of pinch updates once per frame and keeps the final anchor", async () => {
		const { container, element, wrapper, move } = setup();
		const writes = vi.spyOn(container, "scrollTop", "set");
		for (let i = 1; i <= 120; i++) move(1 + i / 120);
		expect(writes).toHaveBeenCalledTimes(0);
		await act(
			() =>
				new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
		);
		expect(writes).toHaveBeenCalledTimes(1);
		expect(wrapper.style.width).toBe("1200px");
		expect(element.style.transform).toBe("scale3d(2, 2, 1)");
		expect(container.scrollTop).toBeCloseTo(150);
		expect(state.updateZoom).toHaveBeenCalledTimes(1);
	});
	it("flushes the last pending frame at gesture end and restores native WebKit zoom", () => {
		const { container, element, wrapper, handlers, move } = setup();
		move(2);
		handlers.onPinchEnd!({} as never);
		expect(wrapper.style.width).toBe("1200px");
		expect(element.style.zoom).toBe("2");
		expect(element.style.transform).toBe("none");
		expect(container.scrollTop).toBeCloseTo(150);
		expect(state.updateZoom).toHaveBeenCalledTimes(1);
	});
	it("uses the newest scale when zoom direction reverses before a paint", async () => {
		const { container, wrapper, move } = setup();
		move(3);
		move(1.5);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		expect(wrapper.style.width).toBe("900px");
		expect(container.scrollTop).toBeCloseTo(75);
		expect(container.scrollLeft).toBeCloseTo(75);
		expect(state.updateZoom).toHaveBeenCalledTimes(1);
	});
	it("anchors an external zoom to the applied frame when pinch work is queued", async () => {
		const { container, wrapper, move, rerender } = setup();
		container.scrollTop = 300;
		move(2);
		state.zoom = 1.5;
		rerender();
		expect(wrapper.style.width).toBe("900px");
		expect(container.scrollTop).toBeCloseTo(450);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		expect(container.scrollTop).toBeCloseTo(450);
		expect(state.updateZoom).not.toHaveBeenCalled();
	});
	it("discards queued work on unmount", async () => {
		const { container, move } = setup();
		const writes = vi.spyOn(container, "scrollTop", "set");
		move(2);
		cleanup();
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		expect(writes).toHaveBeenCalledTimes(0);
	});
});
