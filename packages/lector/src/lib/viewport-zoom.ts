type ApplyZoom = (zoom: number) => void;
const viewportZoomHandlers = new WeakMap<HTMLDivElement, ApplyZoom>();

/**
 * Set on the zoomed pages element while WebKit layout zoom (CSS `zoom`) is
 * applied, and absent otherwise. Text layers read them to lay their text out
 * unzoomed and scale it instead (see TextLayer).
 */
export const LAYOUT_ZOOM_PROPERTY = "--lector-layout-zoom";
export const LAYOUT_ZOOM_INVERSE_PROPERTY = "--lector-layout-zoom-inverse";

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
