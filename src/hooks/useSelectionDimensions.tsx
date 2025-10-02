import { type HighlightRect, PDFStore } from "../internal";

const MERGE_THRESHOLD = 2; // Reduced threshold for more precise merging

type CollapsibleSelection = {
	highlights: HighlightRect[];
	underlines?: HighlightRect[];
	text: string;
	isCollapsed: boolean;
};

const shouldMergeRects = (
	rect1: HighlightRect,
	rect2: HighlightRect,
): boolean => {
	// Only merge if they actually overlap or are immediately adjacent
	const verticalOverlap = !(
		rect1.top > rect2.top + rect2.height || rect2.top > rect1.top + rect1.height
	);

	// Check for actual overlap or immediate adjacency (no gaps)
	const horizontallyConnected =
		Math.abs(rect1.left + rect1.width - rect2.left) <= MERGE_THRESHOLD ||
		Math.abs(rect2.left + rect2.width - rect1.left) <= MERGE_THRESHOLD ||
		(rect1.left < rect2.left + rect2.width &&
			rect2.left < rect1.left + rect1.width); // Actual overlap

	return verticalOverlap && horizontallyConnected;
};

// New function to consolidate highlights more aggressively to prevent overlaps
const consolidateHighlightRects = (rects: HighlightRect[]): HighlightRect[] => {
	if (rects.length <= 1) return rects;

	// Use a more aggressive approach similar to underline consolidation
	const consolidated: HighlightRect[] = [];
	const sorted = [...rects].sort((a, b) => {
		const pageCompare = a.pageNumber - b.pageNumber;
		if (pageCompare !== 0) return pageCompare;
		const topDiff = a.top - b.top;
		return Math.abs(topDiff) < 2 ? a.left - b.left : topDiff;
	});

	let current = sorted[0];
	if (!current) return rects;

	for (let i = 1; i < sorted.length; i++) {
		const next = sorted[i];
		if (!next) continue;

		// Check if highlights are on same page and same line (with tolerance)
		const samePageAndLine =
			current.pageNumber === next.pageNumber &&
			Math.abs(current.top - next.top) <
				Math.max(current.height, next.height) * 0.5;

		// Check if they're horizontally adjacent, overlapping, or very close
		const horizontallyConnected =
			samePageAndLine &&
			// Adjacent (touching or very close)
			(Math.abs(current.left + current.width - next.left) <= MERGE_THRESHOLD ||
				Math.abs(next.left + next.width - current.left) <= MERGE_THRESHOLD ||
				// Overlapping
				(current.left < next.left + next.width &&
					next.left < current.left + current.width) ||
				// Very close (small gap)
				Math.abs(current.left + current.width - next.left) <=
					current.height * 0.2);

		if (horizontallyConnected) {
			// Merge the highlights
			const newLeft = Math.min(current.left, next.left);
			const newRight = Math.max(
				current.left + current.width,
				next.left + next.width,
			);
			const newTop = Math.min(current.top, next.top);
			const newBottom = Math.max(
				current.top + current.height,
				next.top + next.height,
			);

			current = {
				left: newLeft,
				top: newTop,
				width: newRight - newLeft,
				height: newBottom - newTop,
				pageNumber: current.pageNumber,
			};
		} else {
			consolidated.push(current);
			current = next;
		}
	}

	// Don't forget to add the last rectangle
	if (current) {
		consolidated.push(current);
	}

	return consolidated;
};

const consolidateRects = (rects: HighlightRect[]): HighlightRect[] => {
	if (rects.length <= 1) return rects;

	const result: HighlightRect[] = [];
	const visited = new Set<number>();

	for (let i = 0; i < rects.length; i++) {
		if (visited.has(i)) continue;

		const currentRect = rects[i];
		if (!currentRect) continue;

		const currentGroup = [currentRect];
		visited.add(i);

		// Find all rects that should be merged with the current one
		let foundNew = true;
		while (foundNew) {
			foundNew = false;
			for (let j = 0; j < rects.length; j++) {
				if (visited.has(j)) continue;

				const candidateRect = rects[j];
				if (!candidateRect) continue;

				// Check if this rect overlaps with any rect in the current group
				const shouldMergeWithGroup = currentGroup.some((groupRect) =>
					doRectsOverlap(groupRect, candidateRect),
				);

				if (shouldMergeWithGroup) {
					currentGroup.push(candidateRect);
					visited.add(j);
					foundNew = true;
				}
			}
		}

		// Merge all rects in the current group into one
		result.push(mergeRectGroup(currentGroup));
	}

	return result;
};

const doRectsOverlap = (
	rect1: HighlightRect,
	rect2: HighlightRect,
): boolean => {
	// Check if rectangles overlap (not just touch)
	const horizontalOverlap =
		rect1.left < rect2.left + rect2.width &&
		rect2.left < rect1.left + rect1.width;
	const verticalOverlap =
		rect1.top < rect2.top + rect2.height &&
		rect2.top < rect1.top + rect1.height;

	// Also consider if they are very close (within threshold)
	const closeEnough = shouldMergeRects(rect1, rect2);

	return (horizontalOverlap && verticalOverlap) || closeEnough;
};

const mergeRectGroup = (rects: HighlightRect[]): HighlightRect => {
	if (rects.length === 1) {
		const rect = rects[0];
		if (!rect) throw new Error("Invalid rect in group");
		return rect;
	}

	const firstRect = rects[0];
	if (!firstRect) throw new Error("Invalid first rect in group");

	let minLeft = firstRect.left;
	let minTop = firstRect.top;
	let maxRight = firstRect.left + firstRect.width;
	let maxBottom = firstRect.top + firstRect.height;

	rects.forEach((rect) => {
		if (!rect) return;
		minLeft = Math.min(minLeft, rect.left);
		minTop = Math.min(minTop, rect.top);
		maxRight = Math.max(maxRight, rect.left + rect.width);
		maxBottom = Math.max(maxBottom, rect.top + rect.height);
	});

	return {
		left: minLeft,
		top: minTop,
		width: maxRight - minLeft,
		height: maxBottom - minTop,
		pageNumber: firstRect.pageNumber,
	};
};

export const useSelectionDimensions = () => {
	const store = PDFStore.useContext();

	const getAnnotationDimension = () => {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed) return;

		const range = selection.getRangeAt(0);
		const highlightRects: HighlightRect[] = [];
		const underlineRects: HighlightRect[] = [];
		const textLayerMapHighlight = new Map<number, HighlightRect[]>();
		const textLayerMapUnderline = new Map<number, HighlightRect[]>();

		// Get valid client rects and filter out tiny ones
		const clientRects = Array.from(range.getClientRects()).filter(
			(rect) => rect.width > 2 && rect.height > 2,
		);

		clientRects.forEach((clientRect) => {
			// Try multiple points to find the text layer, in case the first point misses
			let element = document.elementFromPoint(
				clientRect.left + 1,
				clientRect.top + clientRect.height / 2,
			);

			// If no element found, try center of rect
			if (!element) {
				element = document.elementFromPoint(
					clientRect.left + clientRect.width / 2,
					clientRect.top + clientRect.height / 2,
				);
			}

			// If still no element, try right side
			if (!element) {
				element = document.elementFromPoint(
					clientRect.right - 1,
					clientRect.top + clientRect.height / 2,
				);
			}

			// Try top and bottom of rect as well
			if (!element) {
				element = document.elementFromPoint(
					clientRect.left + clientRect.width / 2,
					clientRect.top + 1,
				);
			}

			if (!element) {
				element = document.elementFromPoint(
					clientRect.left + clientRect.width / 2,
					clientRect.bottom - 1,
				);
			}

			const textLayer = element?.closest(".textLayer");
			if (!textLayer) return;

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

			const pageNumber = parseInt(
				textLayer.getAttribute("data-page-number") || "1",
				10,
			);
			const textLayerRect = textLayer.getBoundingClientRect();
			const zoom = store.getState().zoom;

			// Always create highlight rectangle
			const highlightRect: HighlightRect = {
				width: clientRect.width / zoom,
				height: clientRect.height / zoom,
				top: (clientRect.top - textLayerRect.top) / zoom,
				left: (clientRect.left - textLayerRect.left) / zoom,
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
					top: (clientRect.top - textLayerRect.top + baselineOffset) / zoom,
					left: (clientRect.left - textLayerRect.left) / zoom,
					pageNumber,
				};

				if (!textLayerMapUnderline.has(pageNumber)) {
					textLayerMapUnderline.set(pageNumber, []);
				}
				textLayerMapUnderline.get(pageNumber)?.push(underlineRect);
			}
		});

		// Process highlight rectangles - use original consolidation for now
		textLayerMapHighlight.forEach((rects) => {
			if (rects.length > 0) {
				// For single rects, just add directly. For multiple, consolidate.
				if (rects.length === 1) {
					highlightRects.push(...rects);
				} else {
					const consolidated = consolidateHighlightRects(rects);
					highlightRects.push(...consolidated);
				}
			}
		});

		// Skip final consolidation for now to debug
		// if (highlightRects.length > 1) {
		//   const finalHighlights = consolidateHighlightRects(highlightRects);
		//   console.log('After final consolidation:', finalHighlights.length, 'rects');
		//   highlightRects.length = 0; // Clear array
		//   highlightRects.push(...finalHighlights);
		// }

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
			text: range.toString().trim(),
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

		// Get valid client rects and filter out tiny ones
		const clientRects = Array.from(range.getClientRects()).filter(
			(rect) => rect.width > 2 && rect.height > 2,
		);

		clientRects.forEach((clientRect) => {
			const element = document.elementFromPoint(
				clientRect.left + 1,
				clientRect.top + clientRect.height / 2,
			);

			const textLayer = element?.closest(".textLayer");
			if (!textLayer) return;

			const pageNumber = parseInt(
				textLayer.getAttribute("data-page-number") || "1",
				10,
			);
			const textLayerRect = textLayer.getBoundingClientRect();
			const zoom = store.getState().zoom;

			const rect: HighlightRect = {
				width: clientRect.width / zoom,
				height: clientRect.height / zoom,
				top: (clientRect.top - textLayerRect.top) / zoom,
				left: (clientRect.left - textLayerRect.left) / zoom,
				pageNumber,
			};

			if (!textLayerMap.has(pageNumber)) {
				textLayerMap.set(pageNumber, []);
			}
			textLayerMap.get(pageNumber)?.push(rect);
		});

		textLayerMap.forEach((rects) => {
			if (rects.length > 0) {
				const consolidated = consolidateRects(rects);
				highlights.push(...consolidated);
			}
		});

		return {
			highlights: highlights.sort((a, b) => a.pageNumber - b.pageNumber),
			text: range.toString().trim(),
			isCollapsed: false,
		};
	};

	const getSelection = (): CollapsibleSelection =>
		getDimension() as CollapsibleSelection;

	return { getDimension, getSelection, getAnnotationDimension };
};
