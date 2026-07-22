import { describe, expect, it, vi } from "vitest";

import { getDestinationScrollTop } from "./layers/useAnnotationLayer";
import { LinkService } from "./usePDFLinkService";

const xyzDest = (num: number) => [
	{ num, gen: 0 },
	{ name: "XYZ" },
	100,
	200,
	null,
];

describe("LinkService page navigation callbacks", () => {
	it("dispatches to the latest registrant", () => {
		const service = new LinkService();
		const first = vi.fn();
		const second = vi.fn();

		service.registerPageNavigationCallback(first);
		service.registerPageNavigationCallback(second);
		service.goToPage(3);

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledWith(3, undefined);
	});

	it("keeps a newer registration when an older layer unregisters", () => {
		// Regression: with a single callback slot, any unmounting page layer
		// wiped whatever callback was registered last, killing internal links.
		const service = new LinkService();
		const older = vi.fn();
		const newer = vi.fn();

		service.registerPageNavigationCallback(older);
		service.registerPageNavigationCallback(newer);
		service.unregisterPageNavigationCallback(older);
		service.goToPage(5);

		expect(newer).toHaveBeenCalledWith(5, undefined);
	});

	it("re-registering an existing callback makes it the latest registrant", () => {
		const service = new LinkService();
		const first = vi.fn();
		const second = vi.fn();

		service.registerPageNavigationCallback(first);
		service.registerPageNavigationCallback(second);
		service.registerPageNavigationCallback(first);
		service.goToPage(4);

		expect(second).not.toHaveBeenCalled();
		expect(first).toHaveBeenCalledWith(4, undefined);
	});

	it("clears everything when unregistering without an argument", () => {
		const service = new LinkService();
		const callback = vi.fn();

		service.registerPageNavigationCallback(callback);
		service.unregisterPageNavigationCallback();
		service.goToPage(2);

		expect(callback).not.toHaveBeenCalled();
	});

	it("rejects out-of-range page numbers in goToPage", () => {
		const service = new LinkService();
		const callback = vi.fn();

		service.setDocument({ numPages: 10 } as never);
		service.registerPageNavigationCallback(callback);

		service.goToPage(0);
		service.goToPage(-3);
		service.goToPage(11);
		service.goToPage(2.5);
		expect(callback).not.toHaveBeenCalled();

		service.goToPage(10);
		expect(callback).toHaveBeenCalledWith(10, undefined);
	});

	it("resolves named destinations and forwards the explicit destination", async () => {
		const service = new LinkService();
		const callback = vi.fn();
		const explicitDest = xyzDest(7);

		service.setDocument({
			getDestination: vi.fn(async () => explicitDest),
			getPageIndex: vi.fn(async () => 7),
		} as never);

		service.registerPageNavigationCallback(callback);
		await service.goToDestination("bm_CR4");

		expect(callback).toHaveBeenCalledWith(8, explicitDest);
	});

	it("forwards explicit array destinations without a document lookup", async () => {
		const service = new LinkService();
		const callback = vi.fn();
		const explicitDest = xyzDest(2);

		service.setDocument({
			getPageIndex: vi.fn(async () => 2),
		} as never);

		service.registerPageNavigationCallback(callback);
		await service.goToDestination(explicitDest);

		expect(callback).toHaveBeenCalledWith(3, explicitDest);
	});
});

describe("getDestinationScrollTop", () => {
	const viewport = (rotation: number) =>
		({
			rotation,
			height: 800,
			convertToViewportPoint: (x: number, y: number) =>
				rotation % 180 === 0 ? [x, 800 - y] : [y, x],
		}) as never;

	it("converts XYZ destinations to a top offset", () => {
		const dest = [{ num: 1, gen: 0 }, { name: "XYZ" }, 50, 600, null];
		expect(getDestinationScrollTop(viewport(0), dest)).toBe(200);
	});

	it("converts FitH destinations on unrotated pages", () => {
		const dest = [{ num: 1, gen: 0 }, { name: "FitH" }, 600];
		expect(getDestinationScrollTop(viewport(0), dest)).toBe(200);
	});

	it("falls back to a page jump for x-less destinations on sideways pages", () => {
		const dest = [{ num: 1, gen: 0 }, { name: "FitH" }, 600];
		expect(getDestinationScrollTop(viewport(90), dest)).toBeNull();
	});

	it("still positions XYZ destinations on sideways pages", () => {
		const dest = [{ num: 1, gen: 0 }, { name: "XYZ" }, 50, 600, null];
		expect(getDestinationScrollTop(viewport(90), dest)).toBe(50);
	});

	it("positions x-only FitV destinations on sideways pages", () => {
		const dest = [{ num: 1, gen: 0 }, { name: "FitV" }, 50];
		expect(getDestinationScrollTop(viewport(90), dest)).toBe(50);
	});

	it("falls back to a page jump for FitV destinations on upright pages", () => {
		const dest = [{ num: 1, gen: 0 }, { name: "FitV" }, 50];
		expect(getDestinationScrollTop(viewport(0), dest)).toBeNull();
	});

	it("ignores destinations without a position", () => {
		const dest = [{ num: 1, gen: 0 }, { name: "Fit" }];
		expect(getDestinationScrollTop(viewport(0), dest)).toBeNull();
	});
});
