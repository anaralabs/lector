import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakePageProxy = {
	streamTextContent: () => ({}),
	getViewport: () => ({ width: 600, height: 800 }),
	pageNumber: 1,
};

vi.mock("../usePdfPageNumber", () => ({ usePDFPageNumber: () => 1 }));
vi.mock("../../internal", () => ({
	PDFStore: {
		useContext: () => ({
			getState: () => ({ zoom: 1, isPinching: false }),
			subscribe: () => () => {},
		}),
	},
	usePdf: (selector: (state: unknown) => unknown) =>
		selector({ getPdfPageProxy: () => fakePageProxy }),
}));

import { TextLayer } from "../../components/layers/text-layer";

describe("useTextLayer scroll-idle deferral", () => {
	afterEach(() => cleanup());

	it("does not build text spans synchronously on mount", () => {
		const { container } = render(<TextLayer />);
		const layer = container.querySelector(".textLayer");
		expect(layer).not.toBeNull();
		expect(layer?.childElementCount).toBe(0);
	});
});
