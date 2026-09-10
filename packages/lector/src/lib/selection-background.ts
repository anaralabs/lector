import { getTextNodeClientRects } from "./selection-rects";

type Rect = { left: number; top: number; width: number; height: number };

// Compare the original text runs, so a growing bounding box cannot bridge
// unrelated lines or columns. Small font-relative gaps cover spaces in PDFs.
const connected = (a: Rect, b: Rect) => {
	const overlap =
		Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
	const gap =
		Math.max(a.left, b.left) - Math.min(a.left + a.width, b.left + b.width);
	return (
		overlap >= Math.min(a.height, b.height) / 2 &&
		gap <= Math.min(a.height, b.height) * 0.2
	);
};

const mergeTextRuns = (rects: Rect[]): Rect[] => {
	const groups: Rect[][] = [];
	for (const rect of rects) {
		const group = [rect];
		for (let i = groups.length - 1; i >= 0; i--) {
			if (groups[i]!.some((member) => connected(member, rect))) {
				group.push(...groups[i]!);
				groups.splice(i, 1);
			}
		}
		groups.push(group);
	}
	return groups.map((group) => {
		const left = Math.min(...group.map((rect) => rect.left));
		const top = Math.min(...group.map((rect) => rect.top));
		return {
			left,
			top,
			width: Math.max(...group.map((rect) => rect.left + rect.width)) - left,
			height: Math.max(...group.map((rect) => rect.top + rect.height)) - top,
		};
	});
};

const SVG_NS = "http://www.w3.org/2000/svg";

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
			const scaleX = bounds.width / layer.clientWidth;
			const scaleY = bounds.height / layer.clientHeight;
			const rects = mergeTextRuns(
				entry.rects.map((rect) => ({
					left: (rect.left - bounds.left) / scaleX,
					top: (rect.top - bounds.top) / scaleY,
					width: rect.width / scaleX,
					height: rect.height / scaleY,
				})),
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
