import type { PageViewport } from "pdfjs-dist";
import type {
	TextContent,
	TextItem,
	TextMarkedContent,
} from "pdfjs-dist/types/src/display/api";

export type TextLayerItem = TextItem | TextMarkedContent;

export type TextLayerRenderMode = "pretext" | "pdfjs-fallback";

export type TextLayerRun = {
	id: string;
	itemIndex: number;
	pageNumber: number;
	text: string;
	rawText: string;
	dir: string;
	fontName: string;
	fontFamily: string;
	fontShorthand: string;
	fontSize: number;
	lineHeight: number;
	fontAscent: number;
	left: number;
	top: number;
	width: number;
	height: number;
	angle: number;
	scaleX: number;
	isVertical: boolean;
	hasEOL: boolean;
	start: number;
	end: number;
	transform: number[];
	canUseCustomRenderer: boolean;
};

export type TextLayerRunMatch = {
	run: TextLayerRun;
	start: number;
	end: number;
};

export type TextLayerPageModel = {
	pageNumber: number;
	viewport: PageViewport;
	textContent: TextContent;
	runs: TextLayerRun[];
	text: string;
	renderMode: TextLayerRenderMode;
	canUseCustomRenderer: boolean;
	fallbackReason: string | null;
};
