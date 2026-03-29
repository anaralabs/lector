import { layoutWithLines, prepareWithSegments } from "@chenglou/pretext";
import type { PageViewport, PDFPageProxy } from "pdfjs-dist";
import type {
	TextContent,
	TextItem,
	TextStyle,
} from "pdfjs-dist/types/src/display/api";

import type {
	TextLayerItem,
	TextLayerPageModel,
	TextLayerRun,
	TextLayerRunMatch,
} from "./types";

const TEXT_CONTENT_PARAMS = {
	includeMarkedContent: true,
	disableNormalization: false,
} as const;

const DEFAULT_FONT_FAMILY = "sans-serif";
const DEFAULT_ASCENT_RATIO = 0.8;
const MAX_SCALE_CORRECTION = 12;
const MIN_SCALE_CORRECTION = 0.08;
const ROTATION_EPSILON = 0.01;

type CachedPageModel = {
	fingerprint: string;
	model: TextLayerPageModel;
};

const pageModelCache = new WeakMap<PDFPageProxy, CachedPageModel>();

const isTextItem = (item: TextLayerItem): item is TextItem => "str" in item;

const normalizeFontFamily = (fontFamily: string | undefined) => {
	const family = fontFamily?.trim();
	if (!family) {
		return DEFAULT_FONT_FAMILY;
	}

	return family.includes(" ") ? `"${family}"` : family;
};

const getFontAscentRatio = (style: TextStyle | undefined) => {
	if (!style) return DEFAULT_ASCENT_RATIO;
	if (style.ascent) return style.ascent;
	if (style.descent) return 1 + style.descent;
	return DEFAULT_ASCENT_RATIO;
};

const createFontShorthand = (style: TextStyle | undefined, fontSize: number) =>
	`${Math.max(fontSize, 1).toFixed(2)}px ${normalizeFontFamily(style?.fontFamily)}`;

const getRotationDegrees = (transform: number[]) => {
	const angle = Math.atan2(transform[1] ?? 0, transform[0] ?? 0);
	const degrees = (angle * 180) / Math.PI;
	return Number.isFinite(degrees) ? degrees : 0;
};

const isSupportedRotation = (degrees: number) => {
	const normalized = ((degrees % 360) + 360) % 360;
	return (
		Math.abs(normalized - 0) <= ROTATION_EPSILON ||
		Math.abs(normalized - 360) <= ROTATION_EPSILON
	);
};

const getMeasuredWidth = (
	text: string,
	fontShorthand: string,
	lineHeight: number,
	targetWidth: number,
) => {
	if (!text) return 0;

	try {
		const prepared = prepareWithSegments(text, fontShorthand, {
			whiteSpace: "pre-wrap",
		});
		const layout = layoutWithLines(
			prepared,
			Math.max(targetWidth, 1),
			Math.max(lineHeight, 1),
		);
		return layout.lines.reduce(
			(max, line) => Math.max(max, line.width),
			Math.max(targetWidth, 1),
		);
	} catch {
		return Math.max(targetWidth, 1);
	}
};

const getScaleCorrection = (measuredWidth: number, targetWidth: number) => {
	if (!measuredWidth || !targetWidth) return 1;

	const scale = targetWidth / measuredWidth;
	if (!Number.isFinite(scale)) return 1;

	return Math.max(MIN_SCALE_CORRECTION, Math.min(MAX_SCALE_CORRECTION, scale));
};

const getPageTop = (
	viewport: PageViewport,
	transform: number[],
	fontAscent: number,
) => {
	const txY = transform[5] ?? 0;
	return viewport.height - (txY + fontAscent);
};

const createRunFromTextItem = ({
	item,
	style,
	pageNumber,
	viewport,
	startIndex,
	itemIndex,
}: {
	item: TextItem;
	style: TextStyle | undefined;
	pageNumber: number;
	viewport: PageViewport;
	startIndex: number;
	itemIndex: number;
}): TextLayerRun => {
	const transform = item.transform.map((value) => Number(value));
	const angle = getRotationDegrees(transform);
	const fontSize =
		Math.hypot(transform[2] ?? 0, transform[3] ?? 0) || item.height || 1;
	const fontAscent = fontSize * getFontAscentRatio(style);
	const left = transform[4] ?? 0;
	const top = getPageTop(viewport, transform, fontAscent);
	const width = style?.vertical
		? item.height || fontSize
		: item.width || fontSize;
	const height = style?.vertical
		? item.width || fontSize
		: item.height || fontSize;
	const lineHeight = Math.max(fontSize, height || fontSize);
	const fontShorthand = createFontShorthand(style, fontSize);
	const measuredWidth = getMeasuredWidth(
		item.str,
		fontShorthand,
		lineHeight,
		width,
	);
	const scaleX = getScaleCorrection(measuredWidth, width);
	const text = item.str + (item.hasEOL ? "\n" : "");

	return {
		id: `${pageNumber}-${itemIndex}-${startIndex}`,
		itemIndex,
		pageNumber,
		text,
		rawText: item.str,
		dir: item.dir || "ltr",
		fontName: item.fontName,
		fontFamily: normalizeFontFamily(style?.fontFamily),
		fontShorthand,
		fontSize,
		lineHeight,
		fontAscent,
		left,
		top,
		width,
		height,
		angle,
		scaleX,
		isVertical: style?.vertical ?? false,
		hasEOL: item.hasEOL,
		start: startIndex,
		end: startIndex + text.length,
		transform,
		canUseCustomRenderer:
			!style?.vertical &&
			isSupportedRotation(angle) &&
			Number.isFinite(left) &&
			Number.isFinite(top) &&
			Number.isFinite(width) &&
			Number.isFinite(height),
	};
};

export const buildTextLayerPageModelFromTextContent = ({
	pageNumber,
	viewport,
	textContent,
}: {
	pageNumber: number;
	viewport: PageViewport;
	textContent: TextContent;
}): TextLayerPageModel => {
	const runs: TextLayerRun[] = [];
	let nextStartIndex = 0;

	for (let itemIndex = 0; itemIndex < textContent.items.length; itemIndex++) {
		const item = textContent.items[itemIndex] as TextLayerItem | undefined;
		if (!item || !isTextItem(item)) {
			continue;
		}

		const style = textContent.styles[item.fontName];
		const run = createRunFromTextItem({
			item,
			style,
			pageNumber,
			viewport,
			startIndex: nextStartIndex,
			itemIndex,
		});

		runs.push(run);
		nextStartIndex = run.end;
	}

	const canUseCustomRenderer = runs.every((run) => run.canUseCustomRenderer);

	return {
		pageNumber,
		viewport,
		textContent,
		runs,
		text: runs.map((run) => run.text).join(""),
		renderMode: canUseCustomRenderer ? "pretext" : "pdfjs-fallback",
		canUseCustomRenderer,
		fallbackReason: canUseCustomRenderer
			? null
			: runs.find((run) => !run.canUseCustomRenderer)?.isVertical
				? "vertical-text"
				: "unsupported-rotation",
	};
};

const getCacheFingerprint = (pageProxy: PDFPageProxy) =>
	[pageProxy.pageNumber, pageProxy.rotate, ...(pageProxy.view ?? [])].join(":");

export const getTextLayerPageModel = async (
	pageProxy: PDFPageProxy,
): Promise<TextLayerPageModel> => {
	const fingerprint = getCacheFingerprint(pageProxy);
	const cached = pageModelCache.get(pageProxy);
	if (cached && cached.fingerprint === fingerprint) {
		return cached.model;
	}

	const viewport = pageProxy.getViewport({ scale: 1 });
	const textContent = await pageProxy.getTextContent(TEXT_CONTENT_PARAMS);
	const model = buildTextLayerPageModelFromTextContent({
		pageNumber: pageProxy.pageNumber,
		viewport,
		textContent,
	});

	pageModelCache.set(pageProxy, {
		fingerprint,
		model,
	});

	return model;
};

export const clearTextLayerPageModelCache = (pageProxy: PDFPageProxy) => {
	pageModelCache.delete(pageProxy);
};

export const getSearchSnippetForMatch = ({
	model,
	matchIndex,
	searchText,
	textSize = 100,
}: {
	model: TextLayerPageModel;
	matchIndex: number;
	searchText: string;
	textSize?: number;
}) => {
	const start = Math.max(0, matchIndex);
	const end = Math.min(
		model.text.length,
		matchIndex + searchText.length + Math.max(textSize, 0),
	);

	return model.text.slice(start, end);
};

export const getRunsForTextRange = ({
	model,
	start,
	end,
}: {
	model: TextLayerPageModel;
	start: number;
	end: number;
}): TextLayerRunMatch[] => {
	if (end <= start) {
		return [];
	}

	return model.runs
		.filter((run) => run.end > start && run.start < end)
		.map((run) => ({
			run,
			start: Math.max(start, run.start),
			end: Math.min(end, run.end),
		}));
};
