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
	const colors = new WeakMap<
		HTMLElement,
		{ key: string; epoch: number; color: string }
	>();
	let colorEpoch = 0;
	const forget = () => {
		colorEpoch += 1;
	};
	let style: HTMLStyleElement | undefined;

	// A style sheet added, removed, edited, disabled or re-pointed can change
	// ::selection; records are drained synchronously on read, so a consumer that
	// restyles and then selects in the same task still gets the new colour.
	const sheets =
		typeof MutationObserver === "undefined"
			? undefined
			: new MutationObserver(forget);
	sheets?.observe(document.head, {
		childList: true,
		subtree: true,
		characterData: true,
		attributes: true,
		attributeFilter: ["media", "disabled", "href", "rel"],
	});

	// A media query the consumer styles ::selection with answers differently
	// without anything in the DOM changing.
	const scheme =
		typeof matchMedia === "function"
			? matchMedia("(prefers-color-scheme: dark)")
			: undefined;
	scheme?.addEventListener("change", forget);

	// Installed once and kept: removing a stylesheet restyles the whole document,
	// and the rule matches nothing while no layer carries the attribute.
	const ensureStyle = () => {
		if (style) return;
		style = document.createElement("style");
		style.textContent =
			".textLayer[data-lector-selection-active] ::selection { background-color: transparent !important; }";
		document.head.append(style);
		sheets?.takeRecords();
	};

	/** Read the consumer's selection color before suppressing native paint.
	 * Transparent ::selection is respected for existing CustomSelection users.
	 *
	 * Reading it means dropping the attribute that suppresses it, and that
	 * attribute gates a descendant `::selection` rule, so the toggle invalidates
	 * every span in the layer while the getComputedStyle below forces the recalc.
	 * On a dense text layer that is tens of milliseconds per selectionchange, so
	 * the answer is cached until something can change it: a style sheet, the
	 * theming hooks on the document element, or a pointer interaction (`forget`). */
	const selectionColor = (layer: HTMLElement, element: Element) => {
		if (sheets?.takeRecords().length) colorEpoch += 1;
		const root = document.documentElement;
		const key = `${root.className}|${root.dataset.theme ?? ""}|${
			root.dataset.colorScheme ?? ""
		}|${element.className}|${element.parentElement?.className ?? ""}`;
		const cached = colors.get(layer);
		if (cached?.key === key && cached.epoch === colorEpoch) return cached.color;
		const active = layer.hasAttribute("data-lector-selection-active");
		if (active) layer.removeAttribute("data-lector-selection-active");
		const color = getComputedStyle(element, "::selection").backgroundColor;
		if (active) layer.setAttribute("data-lector-selection-active", "");
		colors.set(layer, { key, epoch: colorEpoch, color });
		return color;
	};

	const clear = (layer: HTMLElement) => {
		overlays.get(layer)?.remove();
		overlays.delete(layer);
		layer.removeAttribute("data-lector-selection-active");
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
			const color = selectionColor(layer, entry.element);
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
			ensureStyle();
			layer.setAttribute("data-lector-selection-active", "");
		}
	};
	/** Give up the document-level handles: the suppression stylesheet, the head
	 * observer and the color-scheme listener. For the last layer going away. */
	const destroy = () => {
		sheets?.disconnect();
		scheme?.removeEventListener("change", forget);
		style?.remove();
		style = undefined;
	};
	return { update, clear, forget, destroy };
};
