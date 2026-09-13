type ApplyZoom = (zoom: number) => void;
const viewportZoomHandlers = new WeakMap<HTMLDivElement, ApplyZoom>();

/** Keep viewport geometry and zoom subscribers in the same coordinate space. */
export function applyViewportZoom(
	viewport: HTMLDivElement | null,
	zoom: number,
) {
	if (viewport) viewportZoomHandlers.get(viewport)?.(zoom);
}

export function registerViewportZoom(
	viewport: HTMLDivElement,
	apply: ApplyZoom,
) {
	viewportZoomHandlers.set(viewport, apply);
	return () => {
		if (viewportZoomHandlers.get(viewport) === apply)
			viewportZoomHandlers.delete(viewport);
	};
}
