import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stable fake page proxy. Its streamTextContent/getViewport are only invoked
// inside the deferred build (after the idle timer), so for the synchronous
// assertion below they are never called — and crucially pdf.js is never
// dynamically imported, keeping this test off the vitest-browser dep-reload path.
const fakePageProxy = {
	streamTextContent: () => ({}),
	getViewport: () => ({ width: 600, height: 800 }),
	pageNumber: 1,
};

vi.mock("../usePdfPageNumber", () => ({ usePDFPageNumber: () => 1 }));
vi.mock("../../internal", () => ({
	usePdf: (selector: (state: unknown) => unknown) =>
		selector({ getPdfPageProxy: () => fakePageProxy }),
}));

import { TextLayer } from "../../components/layers/text-layer";

describe("useTextLayer scroll-idle deferral", () => {
	afterEach(() => cleanup());

	// Regression guard for the perf fix: the pdf.js TextLayer build (hundreds of
	// spans per page) must NOT run synchronously on mount. It is deferred behind
	// a scroll-idle timer so pages flicked past during a fast scroll never build.
	// If someone removes the setTimeout, the .textLayer would have spans here.
	it("does not build text spans synchronously on mount", () => {
		const { container } = render(<TextLayer />);
		const layer = container.querySelector(".textLayer");
		expect(layer).not.toBeNull();
		expect(layer?.childElementCount).toBe(0);
	});
});
