import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { usePdfJump } from "./usePdfJump";

const { state } = vi.hoisted(() => ({
	state: {
		virtualizer: {
			scrollElement: null as HTMLDivElement | null,
			scrollRect: { width: 400, height: 500 },
			getOffsetForIndex: () => [800, "start"],
			scrollToOffset: vi.fn(),
			options: { estimateSize: () => 800 },
		},
		setHighlight: vi.fn(),
	},
}));
vi.mock("../../internal", () => ({
	usePdf: (selector: (value: typeof state) => unknown) => selector(state),
}));
afterEach(() => {
	cleanup();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});
test.each([0.5, 1, 2])(
	"centers a highlight at zoom %s without reading layout",
	(zoom) => {
		const viewport = document.createElement("div");
		viewport.style.height = "500px";
		document.body.append(viewport);
		state.virtualizer.scrollElement = viewport;
		state.virtualizer.scrollRect = { width: 400 / zoom, height: 500 / zoom };
		state.virtualizer.scrollToOffset.mockClear();
		const layout = vi.spyOn(viewport, "clientHeight", "get");
		const { result } = renderHook(() => usePdfJump());
		expect(
			result.current.scrollToHighlightRects(
				[{ pageNumber: 2, top: 100, left: 0, width: 40, height: 20 }],
				"pixels",
				"center",
			),
		).toBe(true);
		const logicalOffset = state.virtualizer.scrollToOffset.mock.calls[0]![0];
		const highlightCenterOnScreen = (800 + 100 + 20 / 2 - logicalOffset) * zoom;
		expect(highlightCenterOnScreen).toBeCloseTo(250);
		expect(layout).not.toHaveBeenCalled();
	},
);
