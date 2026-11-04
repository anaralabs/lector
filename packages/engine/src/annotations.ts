// Markup annotations already in the PDF (highlights, notes, ink, ...), as the
// host lists them, read in the raster workers through PDFium's fpdf_annot API.
// Tiles render their appearance streams, so nothing here draws.

import type { Pdfium } from "./pdfium/pdfium.js";
import type { Rect } from "./text";

export type AnnotationKind =
	| "highlight"
	| "underline"
	| "squiggly"
	| "strikeout"
	| "note"
	| "freetext"
	| "ink"
	| "square"
	| "circle"
	| "line"
	| "polygon"
	| "polyline"
	| "stamp"
	| "caret"
	| "file";

/** A reply in a comment thread (an annotation with /IRT pointing at its parent). */
export interface AnnotationReply {
	id: string;
	author?: string;
	contents?: string;
	/** ISO 8601 */
	modified?: string;
}

export interface PdfAnnotation {
	/** /NM when the file has one (stable across apps), else `obj:<object number>`, else `p<page>a<index>` */
	id: string;
	page: number;
	/** index among the page's annotations (FPDFPage_GetAnnot) */
	index: number;
	kind: AnnotationKind;
	/** bounds in page points (top-left origin, as displayed) */
	rect: Rect;
	/** text markup: one rect per quad (a line of text); otherwise `[rect]` */
	rects: Rect[];
	/** ink strokes in page points, as flat [x0, y0, x1, y1, ...] */
	ink?: number[][];
	/** "#rrggbb" from /C */
	color?: string;
	/** /CA, 0-1 */
	opacity: number;
	/** /T */
	author?: string;
	/** /Subj */
	subject?: string;
	/** /Contents: the comment (FreeText: the text shown) */
	contents?: string;
	/** text markup: the page text under the quads */
	text?: string;
	/** ISO 8601, from /M and /CreationDate */
	modified?: string;
	created?: string;
	replies: AnnotationReply[];
}

/** FPDF_ANNOT_* subtype -> kind; links, popups, widgets and the rest are not listed. */
const KINDS: Record<number, AnnotationKind> = {
	1: "note",
	3: "freetext",
	4: "line",
	5: "square",
	6: "circle",
	7: "polygon",
	8: "polyline",
	9: "highlight",
	10: "underline",
	11: "squiggly",
	12: "strikeout",
	13: "stamp",
	14: "caret",
	15: "ink",
	17: "file",
};

export const annotationKind = (subtype: number): AnnotationKind | undefined => KINDS[subtype];

export const isTextMarkup = (kind: AnnotationKind) => kind === "highlight" || kind === "underline" || kind === "squiggly" || kind === "strikeout";

/**
 * A PDF date string ("D:20151220233213+01'00'", any prefix of it) as ISO 8601
 * in UTC; undefined when it does not parse.
 */
export function parsePdfDate(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/.exec(raw.trim());
	if (!m) return undefined;
	const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", z, sign, oh = "00", om = "00"] = m;
	const local = Date.UTC(+y!, +mo - 1, +d, +h, +mi, +s);
	if (!Number.isFinite(local) || +mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59) return undefined;
	const offset = z || !sign ? 0 : (sign === "-" ? -1 : 1) * (+oh * 60 + +om) * 60_000;
	return new Date(local - offset).toISOString();
}

/** 0-1 rgb -> "#rrggbb" */
export function hexColor(r: number, g: number, b: number): string {
	const c = (v: number) =>
		Math.round(Math.min(1, Math.max(0, v)) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${c(r)}${c(g)}${c(b)}`;
}

/** Bounding rect of points (x, y pairs). */
export function boundsOf(xy: ArrayLike<number>): Rect {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (let i = 0; i + 1 < xy.length; i += 2) {
		x0 = Math.min(x0, xy[i]!);
		y0 = Math.min(y0, xy[i + 1]!);
		x1 = Math.max(x1, xy[i]!);
		y1 = Math.max(y1, xy[i + 1]!);
	}
	return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

/** An annotation as read, before threading: `parent` is the page index of its /IRT target. */
export type RawAnnotation = PdfAnnotation & { parent?: number };

/**
 * Folds replies into their thread's root (oldest first) and drops them from
 * the list. A reply whose root is not listed (hidden, a popup, another page)
 * stays a top-level annotation.
 */
export function threadReplies(raw: RawAnnotation[]): PdfAnnotation[] {
	const byIndex = new Map(raw.map((a) => [a.index, a]));
	const rootOf = (a: RawAnnotation) => {
		const seen = new Set<number>();
		let cur = a;
		while (cur.parent !== undefined && !seen.has(cur.index)) {
			seen.add(cur.index);
			const up = byIndex.get(cur.parent);
			if (!up) break;
			cur = up;
		}
		return cur;
	};
	const out: PdfAnnotation[] = [];
	const replies = new Map<number, RawAnnotation[]>();
	for (const a of raw) {
		const root = a.parent === undefined ? a : rootOf(a);
		if (root === a) continue;
		const list = replies.get(root.index) ?? [];
		list.push(a);
		replies.set(root.index, list);
	}
	for (const a of raw) {
		if (a.parent !== undefined && rootOf(a) !== a) continue;
		const { parent: _, ...rest } = a;
		const thread = (replies.get(a.index) ?? []).sort((p, q) => (p.modified ?? "").localeCompare(q.modified ?? ""));
		out.push({ ...rest, replies: [...a.replies, ...thread.map((r) => ({ id: r.id, author: r.author, contents: r.contents, modified: r.modified }))] });
	}
	return out;
}

// ---------------------------------------------------------------- raster-worker side

export interface AnnotContext {
	P: Pdfium;
	heap(): Uint8Array;
	/** PDF user space -> page points (top-left origin, as displayed) */
	toPage(x: number, y: number): [number, number];
}

const ANNOT_HIDDEN = 2;
const ANNOT_NOVIEW = 32;
const COLORTYPE_COLOR = 0;
/** a page with more annotations than this is listed up to it */
const MAX_ANNOTS = 2000;
const MAX_QUADS = 2000;
const MAX_INK_POINTS = 20000;

function utf16(ctx: AnnotContext, fn: (buf: number, len: number) => number): string | undefined {
	const len = fn(0, 0);
	if (len <= 2) return undefined;
	const buf = ctx.P.pdfium.wasmExports.malloc(len);
	try {
		fn(buf, len);
		const text = new TextDecoder("utf-16le").decode(ctx.heap().slice(buf, buf + len)).replace(/\0+$/, "");
		return text || undefined;
	} finally {
		ctx.P.pdfium.wasmExports.free(buf);
	}
}

const str = (ctx: AnnotContext, annot: number, key: string) => utf16(ctx, (b, l) => ctx.P.FPDFAnnot_GetStringValue(annot, key, b, l));

/** /C as "#rrggbb": PDFium refuses to read it when the annotation has an appearance stream, EmbedPDF's getter does not. */
function readColor(ctx: AnnotContext, annot: number, mem: number): string | undefined {
	const { P } = ctx;
	if (!P.FPDFAnnot_HasKey(annot, "C")) return undefined;
	const ok = P.FPDFAnnot_GetColor(annot, COLORTYPE_COLOR, mem, mem + 4, mem + 8, mem + 12) || P.EPDFAnnot_GetColor(annot, COLORTYPE_COLOR, mem, mem + 4, mem + 8);
	if (!ok) return undefined;
	const c = new Uint32Array(ctx.heap().buffer, mem, 3);
	return hexColor(c[0]! / 255, c[1]! / 255, c[2]! / 255);
}

function readOpacity(ctx: AnnotContext, annot: number, mem: number): number {
	if (!ctx.P.FPDFAnnot_GetNumberValue(annot, "CA", mem)) return 1;
	const v = new Float32Array(ctx.heap().buffer, mem, 1)[0]!;
	return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

function mapPoints(ctx: AnnotContext, xy: ArrayLike<number>): number[] {
	const out = new Array<number>(xy.length);
	for (let i = 0; i + 1 < xy.length; i += 2) {
		const [x, y] = ctx.toPage(xy[i]!, xy[i + 1]!);
		out[i] = x;
		out[i + 1] = y;
	}
	return out;
}

/** One rect per quad in page points, and the same quads' bounds in user space (for text lookup). */
function readQuads(ctx: AnnotContext, annot: number, mem: number) {
	const n = Math.min(MAX_QUADS, ctx.P.FPDFAnnot_CountAttachmentPoints(annot));
	const rects = [];
	const user = [];
	for (let i = 0; i < n; i++) {
		if (!ctx.P.FPDFAnnot_GetAttachmentPoints(annot, i, mem)) continue;
		const q = new Float32Array(ctx.heap().buffer, mem, 8);
		const r = boundsOf(mapPoints(ctx, q));
		if (r.w <= 0 || r.h <= 0) continue;
		rects.push(r);
		user.push(boundsOf(q));
	}
	return { rects, user };
}

/** Text inside user-space quads, each trimmed to its middle half so neighbouring lines stay out. */
function quadText(ctx: AnnotContext, textPage: number, quads: Rect[]): string | undefined {
	const { P } = ctx;
	const parts: string[] = [];
	for (const q of quads) {
		const vertical = q.h > q.w * 2;
		const dx = vertical ? q.w / 4 : 0;
		const dy = vertical ? 0 : q.h / 4;
		const args = [q.x + dx, q.y + q.h - dy, q.x + q.w - dx, q.y + dy] as const;
		const n = P.FPDFText_GetBoundedText(textPage, ...args, 0, 0);
		if (n <= 0) continue;
		const buf = P.pdfium.wasmExports.malloc((n + 1) * 2);
		try {
			const got = P.FPDFText_GetBoundedText(textPage, ...args, buf, n + 1);
			parts.push(new TextDecoder("utf-16le").decode(ctx.heap().slice(buf, buf + Math.max(0, got) * 2)).replace(/\0+$/, ""));
		} finally {
			P.pdfium.wasmExports.free(buf);
		}
	}
	const text = parts.join(" ").replace(/-\s+(?=\p{Ll})/gu, "").replace(/\s+/g, " ").trim();
	return text || undefined;
}

function readInk(ctx: AnnotContext, annot: number): number[][] | undefined {
	const { P } = ctx;
	const n = P.FPDFAnnot_GetInkListCount(annot);
	if (n <= 0) return undefined;
	const strokes: number[][] = [];
	let budget = MAX_INK_POINTS;
	for (let i = 0; i < n && budget > 0; i++) {
		const count = Math.min(budget, P.FPDFAnnot_GetInkListPath(annot, i, 0, 0));
		if (count <= 0) continue;
		const buf = P.pdfium.wasmExports.malloc(count * 8);
		try {
			const got = Math.min(count, P.FPDFAnnot_GetInkListPath(annot, i, buf, count));
			strokes.push(mapPoints(ctx, new Float32Array(ctx.heap().buffer, buf, got * 2)));
			budget -= got;
		} finally {
			P.pdfium.wasmExports.free(buf);
		}
	}
	return strokes.length ? strokes : undefined;
}

function readOne(ctx: AnnotContext, page: number, pageIndex: number, index: number, annot: number, mem: number, textPage: () => number): RawAnnotation | null {
	const { P } = ctx;
	const kind = annotationKind(P.FPDFAnnot_GetSubtype(annot));
	if (!kind) return null;
	let parent: number | undefined;
	const irt = P.FPDFAnnot_GetLinkedAnnot(annot, "IRT");
	if (irt) {
		const at = P.FPDFPage_GetAnnotIndex(page, irt);
		if (at >= 0 && at !== index) parent = at;
		P.FPDFPage_CloseAnnot(irt);
	}
	// Replies are often hidden on the page but still belong to their thread.
	if (parent === undefined && P.FPDFAnnot_GetFlags(annot) & (ANNOT_HIDDEN | ANNOT_NOVIEW)) return null;
	if (!P.FPDFAnnot_GetRect(annot, mem)) return null;
	const f = new Float32Array(ctx.heap().buffer, mem, 4);
	const [ax, ay] = ctx.toPage(f[0]!, f[1]!);
	const [bx, by] = ctx.toPage(f[2]!, f[3]!);
	const rect = boundsOf([ax, ay, bx, by]);
	const { rects: quads, user } = isTextMarkup(kind) ? readQuads(ctx, annot, mem) : { rects: [], user: [] };
	const nm = str(ctx, annot, "NM");
	const objectNumber = P.EPDFAnnot_GetObjectNumber(annot);
	return {
		id: nm ?? (objectNumber > 0 ? `obj:${objectNumber}` : `p${pageIndex}a${index}`),
		page: pageIndex,
		index,
		kind,
		rect: quads.length ? boundsOf(quads.flatMap((q) => [q.x, q.y, q.x + q.w, q.y + q.h])) : rect,
		rects: quads.length ? quads : [rect],
		ink: kind === "ink" ? readInk(ctx, annot) : undefined,
		color: readColor(ctx, annot, mem),
		opacity: readOpacity(ctx, annot, mem),
		author: str(ctx, annot, "T"),
		subject: str(ctx, annot, "Subj"),
		contents: str(ctx, annot, "Contents")?.replace(/\r\n?/g, "\n"),
		text: user.length ? quadText(ctx, textPage(), user) : undefined,
		modified: parsePdfDate(str(ctx, annot, "M")),
		created: parsePdfDate(str(ctx, annot, "CreationDate")),
		replies: [],
		parent,
	};
}

/** The page's visible markup annotations in annotation order, replies folded into their threads. */
export function readAnnotations(ctx: AnnotContext, pageIndex: number, page: number): PdfAnnotation[] {
	const { P } = ctx;
	const n = Math.min(MAX_ANNOTS, P.FPDFPage_GetAnnotCount(page));
	if (n <= 0) return [];
	const raw: RawAnnotation[] = [];
	const mem = P.pdfium.wasmExports.malloc(32);
	let tp = 0;
	const textPage = () => (tp ||= P.FPDFText_LoadPage(page));
	try {
		for (let i = 0; i < n; i++) {
			const annot = P.FPDFPage_GetAnnot(page, i);
			if (!annot) continue;
			try {
				const a = readOne(ctx, page, pageIndex, i, annot, mem, textPage);
				if (a) raw.push(a);
			} finally {
				P.FPDFPage_CloseAnnot(annot);
			}
		}
	} finally {
		P.pdfium.wasmExports.free(mem);
		if (tp) P.FPDFText_ClosePage(tp);
	}
	return threadReplies(raw);
}
