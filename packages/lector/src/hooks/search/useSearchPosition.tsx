import type { PDFPageProxy } from "pdfjs-dist";
import type {
	TextContent,
	TextItem,
	TextStyle,
} from "pdfjs-dist/types/src/display/api";

import type { HighlightRect } from "../../internal";
import type { SearchResult } from "./useSearch";

interface TextPosition {
	pageNumber: number;
	text: string;
	matchIndex: number;
	matchLength?: number;
	searchText?: string; // Optional parameter to specify the exact search text to highlight
}

export async function calculateHighlightRects(
	pageProxy: PDFPageProxy,
	textMatch: TextPosition,
): Promise<HighlightRect[]> {
	const matchLength =
		textMatch.matchLength ??
		(textMatch.searchText
			? textMatch.searchText.length
			: textMatch.text.length);
	if (
		!Number.isFinite(matchLength) ||
		matchLength <= 0 ||
		!Number.isFinite(textMatch.matchIndex) ||
		textMatch.matchIndex < 0
	)
		return [];
	const matchEnd = textMatch.matchIndex + matchLength;
	const reader: ReadableStreamDefaultReader<TextContent> = pageProxy
		.streamTextContent()
		.getReader();
	const matchRects: HighlightRect[] = [];
	const viewport = pageProxy.getViewport({ scale: 1 });
	const styles: Record<string, TextStyle> = {};
	let offset = 0;
	let foundEnd = false;
	try {
		read: while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			Object.assign(styles, value.styles);
			for (const item of value.items) {
				if (!("str" in item) || item.str.length === 0) continue;
				const length = item.str.length;
				const start = Math.max(0, textMatch.matchIndex - offset);
				const end = Math.min(length, matchEnd - offset);
				if (end > start && item.str.slice(start, end).trim()) {
					matchRects.push(
						getItemRect(
							item,
							styles[item.fontName],
							viewport,
							start,
							end,
							textMatch.pageNumber,
						),
					);
				}
				offset += length;
				if (offset >= matchEnd) {
					foundEnd = true;
					break read;
				}
			}
		}
	} finally {
		// Each call owns an independent stream. Cancel only its remaining
		// work, leaving other searches and the selectable text layer alone.
		// PDF.js closes locally immediately; its worker acknowledgement can wait
		// on extraction, so do not block delivering an already-complete match.
		if (foundEnd)
			void reader.cancel(new Error("Highlight range found")).catch(() => {});
		reader.releaseLock();
	}

	return mergeAdjacentRects(matchRects);
}

let measurementContext: CanvasRenderingContext2D | null | undefined;

/** Match PDF.js text-layer scaling: measure only the matched item's boundaries. */
function getTextFractions(
	item: TextItem,
	style: TextStyle | undefined,
	start: number,
	end: number,
) {
	const length = item.str.length;
	let from = start / length;
	let to = end / length;
	if (
		(start > 0 || end < length) &&
		style?.fontFamily &&
		!style.vertical &&
		typeof document !== "undefined"
	) {
		if (measurementContext === undefined) {
			const canvas = document.createElement("canvas");
			canvas.width = canvas.height = 0;
			measurementContext = canvas.getContext("2d");
		}
		if (measurementContext) {
			// A fixed font size gives stable ratios even for very small PDF glyphs.
			measurementContext.font = `100px ${style.fontFamily}`;
			const width = measurementContext.measureText(item.str).width;
			if (width > 0) {
				from =
					start === 0
						? 0
						: measurementContext.measureText(item.str.slice(0, start)).width /
							width;
				to =
					end === length
						? 1
						: measurementContext.measureText(item.str.slice(0, end)).width /
							width;
			}
		}
	}
	return item.dir === "rtl"
		? ([1 - to, 1 - from] as const)
		: ([from, to] as const);
}

/** Follow the text baseline and the viewport's crop/rotation, at scale 1. */
function getItemRect(
	item: TextItem,
	style: TextStyle | undefined,
	viewport: ReturnType<PDFPageProxy["getViewport"]>,
	start: number,
	end: number,
	pageNumber: number,
): HighlightRect {
	const angle =
		Math.atan2(item.transform[1], item.transform[0]) -
		(style?.vertical ? Math.PI / 2 : 0);
	const cosine = Math.cos(angle);
	const sine = Math.sin(angle);
	const height = Math.hypot(item.transform[2], item.transform[3]);
	const ascent =
		(style?.ascent ?? (style?.descent ? 1 + style.descent : 1)) * height;
	const width = style?.vertical ? item.height : item.width;
	const [startFraction, endFraction] = getTextFractions(
		item,
		style,
		start,
		end,
	);
	const from = startFraction * width;
	const to = endFraction * width;
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const along of [from, to]) {
		for (const above of [ascent, ascent - height]) {
			const [x, y] = viewport.convertToViewportPoint(
				item.transform[4] + along * cosine - above * sine,
				item.transform[5] + along * sine + above * cosine,
			);
			left = Math.min(left, x!);
			top = Math.min(top, y!);
			right = Math.max(right, x!);
			bottom = Math.max(bottom, y!);
		}
	}
	return { pageNumber, left, top, width: right - left, height: bottom - top };
}

function mergeAdjacentRects(rects: HighlightRect[]): HighlightRect[] {
	if (rects.length <= 1) return rects;

	const merged: HighlightRect[] = [];
	let current = rects[0];

	if (!current) return rects;

	for (let i = 1; i < rects.length; i++) {
		const next = rects[i];

		if (!next) continue;
		if (
			Math.abs(current.top - next.top) < 2 &&
			Math.abs(current.height - next.height) < 2 &&
			Math.max(current.left, next.left) <=
				Math.min(current.left + current.width, next.left + next.width) + 2
		) {
			current = {
				...current,
				left: Math.min(current.left, next.left),
				top: Math.min(current.top, next.top),
				width:
					Math.max(current.left + current.width, next.left + next.width) -
					Math.min(current.left, next.left),
				height:
					Math.max(current.top + current.height, next.top + next.height) -
					Math.min(current.top, next.top),
			};
		} else {
			merged.push(current);
			current = next;
		}
	}
	merged.push(current);

	return merged;
}

export async function processSearchResults(
	result: SearchResult,
	pageProxy: PDFPageProxy,
	searchText?: string,
) {
	const searchTermToHighlight =
		searchText || (result as { searchText?: string }).searchText;

	const highlights = await calculateHighlightRects(pageProxy, {
		pageNumber: result.pageNumber,
		text: result.text,
		matchIndex: result.matchIndex,
		matchLength: result.matchLength,
		searchText: searchTermToHighlight,
	});

	return {
		...result,
		highlights,
	};
}
