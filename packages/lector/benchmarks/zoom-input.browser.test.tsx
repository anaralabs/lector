import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useViewportContainer } from "../src/hooks/viewport/useViewportContainer";

const { state, store } = vi.hoisted(() => {
	const state = {
		zoom: 1,
		isPinching: false,
		zoomOptions: { minZoom: 0.2, maxZoom: 5 },
		viewportRef: { current: null as HTMLDivElement | null },
		setIsPinching: (value: boolean) => {
			state.isPinching = value;
		},
		updateZoom: vi.fn(),
	};
	return { state, store: { getState: () => state } };
});
vi.mock("../src/internal", () => ({
	PDFStore: { useContext: () => store },
	usePdf: (selector: (value: typeof state) => unknown) => selector(state),
}));

afterEach(() => {
	cleanup();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});
it("measures a burst of wheel zoom against a reader-sized DOM", async () => {
	const rows = [];
	for (let trial = 0; trial < 6; trial++) {
		state.isPinching = false;
		const container = document.createElement("div");
		const wrapper = document.createElement("div");
		const element = document.createElement("div");
		container.style.cssText = "width:600px;height:700px;overflow:auto";
		wrapper.style.cssText = "position:relative;width:600px;height:8000px";
		element.style.cssText =
			"position:absolute;width:600px;height:8000px;transform-origin:0 0";
		for (let i = 0; i < 10000; i++) {
			const span = document.createElement("span");
			span.style.cssText = `position:absolute;top:${i % 8000}px;left:${i % 600}px`;
			span.textContent = "PDF text";
			element.append(span);
		}
		wrapper.append(element);
		container.append(wrapper);
		document.body.append(container);
		renderHook(() =>
			useViewportContainer({
				containerRef: { current: container },
				elementWrapperRef: { current: wrapper },
				elementRef: { current: element },
			}),
		);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const writes = vi.spyOn(container, "scrollTop", "set");
		const started = performance.now();
		for (let i = 0; i < 120; i++)
			container.dispatchEvent(
				new WheelEvent("wheel", {
					deltaY: -0.3,
					ctrlKey: true,
					clientX: 300,
					clientY: 350,
					bubbles: true,
					cancelable: true,
				}),
			);
		const handlerMs = performance.now() - started;
		const synchronousWrites = writes.mock.calls.length;
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const frameMs = performance.now() - started;
		rows.push({
			handlerMs,
			frameMs,
			synchronousWrites,
			totalWrites: writes.mock.calls.length,
			zoomWidth: wrapper.style.width,
		});
		expect(parseFloat(wrapper.style.width)).toBeGreaterThan(600);
		cleanup();
		container.remove();
		vi.restoreAllMocks();
	}
	console.log(
		"ZOOM_INPUT_BENCHMARK",
		JSON.stringify({
			events: 120,
			textNodes: 10000,
			warmup: 1,
			runs: rows.slice(1),
		}),
	);
});
