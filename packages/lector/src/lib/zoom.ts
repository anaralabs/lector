import type { PageViewport } from "pdfjs-dist";

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
