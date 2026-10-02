import type { PageViewport } from "pdfjs-dist";

// Pre-26 Safari reports client rects under CSS `zoom` unscaled, so selection hit-testing lands on the wrong lines.
export const zoomScalesClientRects = (doc: Document) => {
	const root = doc.documentElement;
	if (!root) return false;
	const probe = doc.createElement("div");
	probe.style.cssText =
		"position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;zoom:2";
	const child = doc.createElement("div");
	child.style.cssText = "width:10px;height:10px";
	probe.appendChild(child);
	root.appendChild(probe);
	const { width } = child.getBoundingClientRect();
	probe.remove();
	return width > 15;
};

export const USE_LAYOUT_ZOOM =
	typeof navigator !== "undefined" &&
	typeof document !== "undefined" &&
	/AppleWebKit/i.test(navigator.userAgent) &&
	!/Chrome|Chromium|Android/i.test(navigator.userAgent) &&
	zoomScalesClientRects(document);

export const getFitWidthZoom = (
	containerWidth: number,
	viewports: PageViewport[],
	zoomOptions: { minZoom: number; maxZoom: number },
) => {
	const { minZoom, maxZoom } = zoomOptions;
	const maxPageWidth = Math.max(...viewports.map((viewport) => viewport.width));

	// Calculate the zoom level needed to fit the width
	// Subtract some padding (40px) to ensure there's a small margin
	const targetZoom = containerWidth / maxPageWidth;

	// Ensure the zoom level stays within bounds
	const clampedZoom = Math.min(Math.max(targetZoom, minZoom), maxZoom);

	return clampedZoom;
};
