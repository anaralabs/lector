import { type HighlightRect, PDFStore } from "../internal";
import { getTextNodeClientRects, mergeTextRuns } from "../lib/selection-rects";
import { getPdfSelectionText } from "../lib/selection-text";
import type { SelectionTextOptions } from "../lib/text-normalization";

const MERGE_THRESHOLD = 2; // Reduced threshold for more precise merging
const LAYER_ATTRIBUTION_TOLERANCE_PX = 4;

type CollapsibleSelection = {
	highlights: HighlightRect[];
	underlines?: HighlightRect[];
	text: string;
	isCollapsed: boolean;
};

type MappedSelectionRect = {
	clientRect: DOMRect;
	sourceElement: Element | null;
	layer: HTMLElement;
	layerRect: DOMRect;
	pageNumber: number;
};

/**
 * Map each selection rect to the `.textLayer` it belongs to. Geometric
 * containment first (works for off-viewport rects, where elementFromPoint
 * returns null), with a 5-point elementFromPoint fallback.
 */
const mapSelectionRectsToLayers = (range: Range): MappedSelectionRect[] => {
	const clientRects = getTextNodeClientRects(range).filter(
		({ rect }) => rect.width > 2 && rect.height > 2,
	);

	const textLayerEntries = Array.from(
		document.querySelectorAll<HTMLElement>(".textLayer"),
	).map((el) => ({ el, rect: el.getBoundingClientRect() }));

	const layerForRect = (rect: DOMRect): HTMLElement | null => {
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const T = LAYER_ATTRIBUTION_TOLERANCE_PX;
		const geomMatch = textLayerEntries.find(
			({ rect: lr }) =>
				cx >= lr.left - T &&
				cx <= lr.right + T &&
				cy >= lr.top - T &&
				cy <= lr.bottom + T,
		);
		if (geomMatch) return geomMatch.el;

		const points: Array<[number, number]> = [
			[rect.left + 1, cy],
			[cx, cy],
			[rect.right - 1, cy],
			[cx, rect.top + 1],
			[cx, rect.bottom - 1],
		];
		for (const [px, py] of points) {
			const el = document.elementFromPoint(px, py);
			const layer = el?.closest<HTMLElement>(".textLayer");
			if (layer) return layer;
		}
		return null;
	};

	const result: MappedSelectionRect[] = [];
	for (const { rect: clientRect, element: sourceElement } of clientRects) {
		const layer = layerForRect(clientRect);
		if (!layer) continue;

		const layerRect = layer.getBoundingClientRect();
		const pageNumber = parseInt(
			layer.getAttribute("data-page-number") || "1",
			10,
		);
		result.push({ clientRect, sourceElement, layer, layerRect, pageNumber });
	}
	return result;
};

export const useSelectionDimensions = () => {
	const store = PDFStore.useContext();
	const getText = (options?: SelectionTextOptions) => {
		const container = store.getState().viewportRef.current;
		return container
			? getPdfSelectionText(
					container.ownerDocument.getSelection(),
					container,
					options,
				)
			: null;
	};

	const getAnnotationDimension = () => {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed) return;

		const range = selection.getRangeAt(0);
		const highlightRects: HighlightRect[] = [];
		const underlineRects: HighlightRect[] = [];
		const textLayerMapHighlight = new Map<number, HighlightRect[]>();
		const textLayerMapUnderline = new Map<number, HighlightRect[]>();

		const mapped = mapSelectionRectsToLayers(range);
		const zoom = store.getState().zoom;

		mapped.forEach(({ clientRect, sourceElement, layerRect, pageNumber }) => {
			const element = sourceElement;

			// Check if the element is part of a superscript or subscript
			const isSuperOrSubScript = (el: Element | null): boolean => {
				if (!el) return false;

				// Check for HTML sup/sub tags - these are the most reliable indicators
				if (
					el.tagName.toLowerCase() === "sup" ||
					el.tagName.toLowerCase() === "sub"
				) {
					return true;
				}

				// Check for common superscript/subscript classes
				const classes = el.className;
				if (typeof classes === "string") {
					const superSubClasses = ["superscript", "subscript", "sup", "sub"];
					if (superSubClasses.some((c) => classes.includes(c))) {
						return true;
					}
				}

				// Very conservative check for reference numbers/citations
				// Only consider extremely small text that's clearly positioned as superscript/subscript
				const elementRect = el.getBoundingClientRect();

				// Only check for superscript/subscript if text is VERY small (< 6px height)
				// and check if it's a single digit or very short text (likely a reference number)
				if (elementRect.height < 6 && elementRect.width < 15) {
					const textContent = el.textContent?.trim() || "";

					// Only consider single digits or very short references as potential superscripts
					if (textContent.length <= 2 && /^[\d\w]{1,2}$/.test(textContent)) {
						const parentRect = el.parentElement?.getBoundingClientRect();
						if (parentRect && parentRect.height > elementRect.height * 2) {
							// Check if element is significantly elevated compared to its parent
							const elementCenter = elementRect.top + elementRect.height / 2;
							const parentCenter = parentRect.top + parentRect.height / 2;
							const verticalOffset = Math.abs(elementCenter - parentCenter);

							// Only consider it superscript if it's clearly elevated and very small
							if (verticalOffset > parentRect.height * 0.4) {
								return true;
							}
						}
					}
				}

				return false;
			};

			const highlightRect: HighlightRect = {
				width: clientRect.width / zoom,
				height: clientRect.height / zoom,
				top: (clientRect.top - layerRect.top) / zoom,
				left: (clientRect.left - layerRect.left) / zoom,
				pageNumber,
			};

			if (!textLayerMapHighlight.has(pageNumber)) {
				textLayerMapHighlight.set(pageNumber, []);
			}
			textLayerMapHighlight.get(pageNumber)?.push(highlightRect);

			// Create underline rectangle - be more permissive now
			const shouldCreateUnderline = !isSuperOrSubScript(element);

			if (shouldCreateUnderline) {
				const baselineOffset = clientRect.height * 0.85;
				const underlineHeight = 2; // Fixed 2px thickness

				const underlineRect: HighlightRect = {
					width: clientRect.width / zoom,
					height: underlineHeight / zoom,
					top: (clientRect.top - layerRect.top + baselineOffset) / zoom,
					left: (clientRect.left - layerRect.left) / zoom,
					pageNumber,
				};

				if (!textLayerMapUnderline.has(pageNumber)) {
					textLayerMapUnderline.set(pageNumber, []);
				}
				textLayerMapUnderline.get(pageNumber)?.push(underlineRect);
			}
		});

		// Use the same line geometry for saved highlights and the selection preview.
		textLayerMapHighlight.forEach((rects) => {
			highlightRects.push(...mergeTextRuns(rects));
		});

		// Process underline rectangles
		textLayerMapUnderline.forEach((rects) => {
			if (rects.length > 0) {
				const lineGroups = groupRectsByLine(rects);
				lineGroups.forEach((group) => {
					if (group.length === 0) return;

					group.sort((a, b) => a.left - b.left);

					// Create individual underlines for each rect in the group if they're not adjacent
					// or create a single continuous underline if they are adjacent
					let i = 0;
					while (i < group.length) {
						const startRect = group[i];
						if (!startRect) {
							i++;
							continue;
						}

						let endIndex = i;

						// Find consecutive adjacent rectangles
						while (endIndex + 1 < group.length) {
							const currentRect = group[endIndex];
							const nextRect = group[endIndex + 1];
							if (!currentRect || !nextRect) break;

							// Check if rectangles are adjacent (allow larger gaps for mathematical content)
							const gap =
								nextRect.left - (currentRect.left + currentRect.width);
							const maxGapAllowed = Math.max(
								MERGE_THRESHOLD,
								currentRect.height * 0.3,
							); // Allow gap up to 30% of height
							if (gap <= maxGapAllowed) {
								endIndex++;
							} else {
								break;
							}
						}

						const endRect = group[endIndex];
						if (!endRect) {
							i++;
							continue;
						}

						// Create underline rectangle with consistent thickness
						const lineRect: HighlightRect = {
							width: endRect.left + endRect.width - startRect.left,
							height: 1.5,
							top: startRect.top,
							left: startRect.left,
							pageNumber: startRect.pageNumber,
						};
						underlineRects.push(lineRect);

						i = endIndex + 1;
					}
				});
			}
		});

		// Fallback: If no underlines were created but we have highlights,
		// create underlines from highlights (for mathematical content, etc.)
		if (underlineRects.length === 0 && highlightRects.length > 0) {
			highlightRects.forEach((highlightRect) => {
				const baselineOffset = highlightRect.height * 0.85;
				const underlineHeight = 1.5; // Fixed 2px thickness accounting for zoom

				const underlineRect: HighlightRect = {
					width: highlightRect.width,
					height: underlineHeight,
					top: highlightRect.top + baselineOffset,
					left: highlightRect.left,
					pageNumber: highlightRect.pageNumber,
				};
				underlineRects.push(underlineRect);
			});
		}

		return {
			highlights: highlightRects.sort((a, b) => a.pageNumber - b.pageNumber),
			underlines: consolidateUnderlines(underlineRects).sort(
				(a, b) => a.pageNumber - b.pageNumber,
			),
			text: (getText() ?? range.toString()).trim(),
			isCollapsed: false,
		};
	};

	// Helper function to group rectangles by line with vertical tolerance
	const groupRectsByLine = (rects: HighlightRect[]): HighlightRect[][] => {
		const VERTICAL_TOLERANCE = 3; // pixels
		const groups: HighlightRect[][] = [];

		rects.forEach((rect) => {
			const centerY = rect.top + rect.height / 2;
			let foundGroup = false;

			for (const group of groups) {
				if (group.length === 0) continue;
				const firstRect = group[0];
				if (!firstRect) continue;

				const groupCenterY = firstRect.top + firstRect.height / 2;
				if (Math.abs(centerY - groupCenterY) <= VERTICAL_TOLERANCE) {
					group.push(rect);
					foundGroup = true;
					break;
				}
			}

			if (!foundGroup) {
				groups.push([rect]);
			}
		});

		return groups;
	};

	// Helper function to consolidate overlapping underlines to prevent thickness variations
	const consolidateUnderlines = (
		underlines: HighlightRect[],
	): HighlightRect[] => {
		if (underlines.length <= 1) return underlines;

		const consolidated: HighlightRect[] = [];
		const sorted = [...underlines].sort((a, b) => {
			const pageCompare = a.pageNumber - b.pageNumber;
			if (pageCompare !== 0) return pageCompare;
			const topCompare = a.top - b.top;
			return Math.abs(topCompare) < 1 ? a.left - b.left : topCompare;
		});

		let current = sorted[0]!;

		for (let i = 1; i < sorted.length; i++) {
			const next = sorted[i]!;

			// Check if underlines are on same page and vertically aligned (overlapping)
			const samePageAndLine =
				current.pageNumber === next.pageNumber &&
				Math.abs(current.top - next.top) < 1;

			// Check if they're horizontally adjacent or overlapping
			const horizontallyConnected =
				samePageAndLine &&
				(Math.abs(current.left + current.width - next.left) <=
					MERGE_THRESHOLD ||
					(current.left < next.left + next.width &&
						next.left < current.left + current.width));

			if (horizontallyConnected) {
				// Merge the underlines
				const newWidth =
					Math.max(current.left + current.width, next.left + next.width) -
					Math.min(current.left, next.left);
				current = {
					...current,
					left: Math.min(current.left, next.left),
					width: newWidth,
				};
			} else {
				consolidated.push(current);
				current = next;
			}
		}

		consolidated.push(current);
		return consolidated;
	};

	const getDimension = () => {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed) return;

		const range = selection.getRangeAt(0);
		const highlights: HighlightRect[] = [];
		const textLayerMap = new Map<number, HighlightRect[]>();

		const mapped = mapSelectionRectsToLayers(range);
		const zoom = store.getState().zoom;

		mapped.forEach(({ clientRect, layerRect, pageNumber }) => {
			const rect: HighlightRect = {
				width: clientRect.width / zoom,
				height: clientRect.height / zoom,
				top: (clientRect.top - layerRect.top) / zoom,
				left: (clientRect.left - layerRect.left) / zoom,
				pageNumber,
			};

			if (!textLayerMap.has(pageNumber)) {
				textLayerMap.set(pageNumber, []);
			}
			textLayerMap.get(pageNumber)?.push(rect);
		});

		textLayerMap.forEach((rects) => {
			if (rects.length > 0) {
				const consolidated = mergeTextRuns(rects);
				highlights.push(...consolidated);
			}
		});

		return {
			highlights: highlights.sort((a, b) => a.pageNumber - b.pageNumber),
			text: (getText() ?? range.toString()).trim(),
			isCollapsed: false,
		};
	};

	const getSelection = (): CollapsibleSelection =>
		getDimension() as CollapsibleSelection;

	return { getDimension, getSelection, getAnnotationDimension, getText };
};
