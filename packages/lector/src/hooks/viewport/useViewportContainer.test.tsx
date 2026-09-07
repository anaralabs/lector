import { cleanup, renderHook } from "@testing-library/react";
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
