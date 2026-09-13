import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let media: MediaQueryList | undefined;
const getSnapshot = () => Math.min(window.devicePixelRatio || 1, 3);
const getServerSnapshot = () => 1;

function unlisten() {
	if (!media) return;
	if (typeof media.removeEventListener === "function")
		media.removeEventListener("change", onChange);
	else media.removeListener(onChange);
}
function watchResolution() {
	unlisten();
	// Watch the actual resolution, even when the rendered DPR is capped.
	// A min-resolution query misses increases and some monitor transitions.
	media = window.matchMedia(
		`(resolution: ${window.devicePixelRatio || 1}dppx), (-webkit-device-pixel-ratio: ${window.devicePixelRatio || 1})`,
	);
	if (typeof media.addEventListener === "function")
		media.addEventListener("change", onChange);
	else media.addListener(onChange);
}
function onChange() {
	watchResolution();
	for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
	listeners.add(listener);
	if (listeners.size === 1) watchResolution();
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			unlisten();
			media = undefined;
		}
	};
}

export const useDpr = () =>
	useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
