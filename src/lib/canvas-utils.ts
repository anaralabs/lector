export const MAX_CANVAS_PIXELS = 16777216;
export const MAX_CANVAS_DIMENSION = 32767;

export function clampScaleForPage(
	targetScale: number,
	pageWidth: number,
	pageHeight: number,
): number {
	if (!targetScale) {
		return 0;
	}

	const areaLimit = Math.sqrt(
		MAX_CANVAS_PIXELS / Math.max(pageWidth * pageHeight, 1),
	);
	const widthLimit = MAX_CANVAS_DIMENSION / Math.max(pageWidth, 1);
	const heightLimit = MAX_CANVAS_DIMENSION / Math.max(pageHeight, 1);

	const safeScale = Math.min(
		targetScale,
		Number.isFinite(areaLimit) ? areaLimit : targetScale,
		Number.isFinite(widthLimit) ? widthLimit : targetScale,
		Number.isFinite(heightLimit) ? heightLimit : targetScale,
	);

	return Math.max(safeScale, 0);
}
