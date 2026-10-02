import { describe, expect, it } from "vitest";

import { zoomScalesClientRects } from "./zoom";

describe("zoomScalesClientRects", () => {
	it("detects standardized CSS zoom in the test browser", () => {
		expect(zoomScalesClientRects(document)).toBe(true);
	});

	it("leaves no probe behind", () => {
		const before = document.documentElement.childElementCount;
		zoomScalesClientRects(document);
		expect(document.documentElement.childElementCount).toBe(before);
	});
});
