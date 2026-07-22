import { describe, expect, it, vi } from "vitest";

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

	it("clears everything when unregistering without an argument", () => {
		const service = new LinkService();
		const callback = vi.fn();

		service.registerPageNavigationCallback(callback);
		service.unregisterPageNavigationCallback();
		service.goToPage(2);

		expect(callback).not.toHaveBeenCalled();
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
