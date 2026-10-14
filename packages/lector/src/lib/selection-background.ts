import { getTextNodeClientRects, mergeTextRuns } from "./selection-rects";

const SVG_NS = "http://www.w3.org/2000/svg";

type Box = { left: number; top: number; width: number; height: number };

/** Maps a client rect into the text layer's own unrotated coordinates. Client
 * rects already include the page rotation, so it has to be undone here. */
export const toLayerRect = (
	rect: Box,
	bounds: Box,
	layerWidth: number,
	layerHeight: number,
	rotation: number,
): Box => {
	const x = (rect.left - bounds.left) / bounds.width;
	const y = (rect.top - bounds.top) / bounds.height;
	const w = rect.width / bounds.width;
	const h = rect.height / bounds.height;
	const [left, top, width, height] =
		rotation === 90
			? [y, 1 - x - w, h, w]
			: rotation === 180
				? [1 - x - w, 1 - y - h, w, h]
				: rotation === 270
					? [1 - y - h, x, h, w]
					: [x, y, w, h];
	return {
		left: left * layerWidth,
		top: top * layerHeight,
		width: width * layerWidth,
		height: height * layerHeight,
	};
};

// pdf_viewer.css rotates layers by data-main-rotation; without it the layer stays upright.
const layerRotation = (layer: HTMLElement) => {
	const { transform } = getComputedStyle(layer);
	if (!transform || transform === "none") return 0;
	const { a, b } = new DOMMatrix(transform);
	return (
		(((Math.round(Math.atan2(b, a) / (Math.PI / 2)) * 90) % 360) + 360) % 360
	);
};

/** Paint native selection once per page; overlapping PDF spans must not
 * composite their translucent backgrounds on top of each other. */
export const createSelectionBackground = () => {
	const overlays = new Map<HTMLElement, SVGSVGElement>();
	let style: HTMLStyleElement | undefined;

	const clear = (layer: HTMLElement) => {
		overlays.get(layer)?.remove();
		overlays.delete(layer);
		layer.removeAttribute("data-lector-selection-active");
		if (overlays.size === 0) {
			style?.remove();
			style = undefined;
		}
	};

	const update = (
		selection: Selection | null,
		layers: Iterable<HTMLElement>,
	) => {
		const registered = new Set(layers);
		const byLayer = new Map<
			HTMLElement,
			{ rects: DOMRect[]; element: Element }
		>();
		if (selection && !selection.isCollapsed) {
			for (let i = 0; i < selection.rangeCount; i++) {
				for (const { rect, element } of getTextNodeClientRects(
					selection.getRangeAt(i),
				)) {
					const layer = element?.closest<HTMLElement>(".textLayer");
					if (
						!layer ||
						!element ||
						!registered.has(layer) ||
						rect.width <= 0 ||
						rect.height <= 0
					)
						continue;
					let entry = byLayer.get(layer);
					if (!entry) {
						entry = { rects: [], element };
						byLayer.set(layer, entry);
					}
					entry.rects.push(rect);
				}
			}
		}

		for (const layer of registered) {
			const entry = byLayer.get(layer);
			if (!entry) {
				clear(layer);
				continue;
			}
			// Read the consumer's selection color before suppressing native paint.
			// Transparent ::selection is respected for existing CustomSelection users.
			layer.removeAttribute("data-lector-selection-active");
			const color = getComputedStyle(
				entry.element,
				"::selection",
			).backgroundColor;
			if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") {
				clear(layer);
				continue;
			}
			const bounds = layer.getBoundingClientRect();
			if (
				!bounds.width ||
				!bounds.height ||
				!layer.clientWidth ||
				!layer.clientHeight
			) {
				clear(layer);
				continue;
			}
			const rotation = layerRotation(layer);
			// Merge after mapping: lines only run horizontally in the layer's own space.
			const rects = mergeTextRuns(
				entry.rects.map((rect) =>
					toLayerRect(
						rect,
						bounds,
						layer.clientWidth,
						layer.clientHeight,
						rotation,
					),
				),
			);

			let overlay = overlays.get(layer);
			if (!overlay) {
				overlay = document.createElementNS(SVG_NS, "svg");
				overlay.dataset.lectorSelection = "";
				overlay.setAttribute("aria-hidden", "true");
				overlay.style.cssText =
					"position:absolute;inset:0;width:100%;height:100%;pointer-events:none;user-select:none;transform:none;z-index:0;overflow:visible";
				overlay.append(document.createElementNS(SVG_NS, "path"));
				layer.append(overlay);
				overlays.set(layer, overlay);
			}
			const path = overlay.firstElementChild!;
			// A single nonzero-filled path also unions any remaining overlapping lines,
			// without filling the empty space between them or doubling their opacity.
			path.setAttribute(
				"d",
				rects
					.map(
						(rect) =>
							`M${rect.left} ${rect.top}h${rect.width}v${rect.height}h${-rect.width}Z`,
					)
					.join(" "),
			);
			path.setAttribute("fill", color);
			if (!style) {
				style = document.createElement("style");
				style.textContent =
					".textLayer[data-lector-selection-active] ::selection { background-color: transparent !important; }";
				document.head.append(style);
			}
			layer.setAttribute("data-lector-selection-active", "");
		}
	};
	return { update, clear };
};
