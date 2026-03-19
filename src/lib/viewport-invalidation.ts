type ViewportCallback = () => void;

interface ViewportInvalidationEntry {
	callbacks: Set<ViewportCallback>;
	scrollListener: () => void;
	windowResizeListener: () => void;
	resizeObserver?: ResizeObserver;
	rafId: number | null;
}

const viewportInvalidationRegistry = new WeakMap<
	HTMLDivElement,
	ViewportInvalidationEntry
>();

const notifyCallbacks = (entry: ViewportInvalidationEntry) => {
	entry.rafId = null;

	entry.callbacks.forEach((callback) => {
		callback();
	});
};

const scheduleInvalidation = (entry: ViewportInvalidationEntry) => {
	if (entry.rafId !== null) {
		return;
	}

	entry.rafId = requestAnimationFrame(() => {
		notifyCallbacks(entry);
	});
};

export const subscribeToViewportInvalidation = (
	viewport: HTMLDivElement,
	callback: ViewportCallback,
) => {
	let entry = viewportInvalidationRegistry.get(viewport);

	if (!entry) {
		const callbacks = new Set<ViewportCallback>();
		const schedule = () => {
			const currentEntry = viewportInvalidationRegistry.get(viewport);
			if (!currentEntry) {
				return;
			}

			scheduleInvalidation(currentEntry);
		};

		entry = {
			callbacks,
			scrollListener: schedule,
			windowResizeListener: schedule,
			resizeObserver:
				typeof ResizeObserver === "undefined"
					? undefined
					: new ResizeObserver(schedule),
			rafId: null,
		};

		viewport.addEventListener("scroll", entry.scrollListener, {
			passive: true,
		});
		window.addEventListener("resize", entry.windowResizeListener, {
			passive: true,
		});
		entry.resizeObserver?.observe(viewport);

		viewportInvalidationRegistry.set(viewport, entry);
	}

	entry.callbacks.add(callback);

	return () => {
		const currentEntry = viewportInvalidationRegistry.get(viewport);
		if (!currentEntry) {
			return;
		}

		currentEntry.callbacks.delete(callback);

		if (currentEntry.callbacks.size > 0) {
			return;
		}

		if (currentEntry.rafId !== null) {
			cancelAnimationFrame(currentEntry.rafId);
		}

		viewport.removeEventListener("scroll", currentEntry.scrollListener);
		window.removeEventListener("resize", currentEntry.windowResizeListener);
		currentEntry.resizeObserver?.disconnect();
		viewportInvalidationRegistry.delete(viewport);
	};
};
