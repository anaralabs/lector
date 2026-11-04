// Raster-worker side of form filling: reads a page's widgets and applies edits
// through PDFium's form fill environment. Every worker applies every edit, in
// the same order, so their documents stay identical.

import type { Box, FieldKind, FormOp, FormWidget } from "./forms";
import type { Pdfium } from "./pdfium/pdfium.js";

export interface FormContext {
	P: Pdfium;
	doc: number;
	form: number;
	heap(): Uint8Array;
	withPage<T>(index: number, fn: (page: number) => T): T;
	/** PDF user space -> page points (top-left origin) */
	toPage(index: number, x: number, y: number): [number, number];
	/** page points (top-left origin) -> PDF user space */
	toUser(index: number, x: number, y: number): [number, number];
}

const ANNOT_WIDGET = 20;
const ANNOT_HIDDEN = 2;
const ANNOT_NOVIEW = 32;
const FIELD_READONLY = 1;
const TEXT_MULTILINE = 1 << 12;
const TEXT_PASSWORD = 1 << 13;
const BACKSPACE = 8;
/** by FPDF_FORMFIELD_* type */
const FIELD_KINDS: FieldKind[] = ["unknown", "button", "checkbox", "radio", "combo", "list", "text", "signature"];

function malloc(ctx: FormContext, n: number) {
	return ctx.P.pdfium.wasmExports.malloc(n);
}
function free(ctx: FormContext, ptr: number) {
	ctx.P.pdfium.wasmExports.free(ptr);
}

/** UTF-16LE string out of a PDFium getter that returns its byte length. */
function utf16(ctx: FormContext, fn: (buf: number, len: number) => number): string {
	const len = fn(0, 0);
	if (len <= 2) return "";
	const buf = malloc(ctx, len);
	try {
		fn(buf, len);
		return new TextDecoder("utf-16le").decode(ctx.heap().slice(buf, buf + len)).replace(/\0+$/, "");
	} finally {
		free(ctx, buf);
	}
}

/** A NUL-terminated UTF-16LE copy of `s` in the WASM heap (FPDF_WIDESTRING). */
function wide(ctx: FormContext, s: string) {
	const buf = malloc(ctx, (s.length + 1) * 2);
	const view = new DataView(ctx.heap().buffer, buf, (s.length + 1) * 2);
	for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
	view.setUint16(s.length * 2, 0, true);
	return buf;
}

function withAnnot<T>(ctx: FormContext, page: number, index: number, fn: (annot: number) => T): T | null {
	const annot = ctx.P.FPDFPage_GetAnnot(page, index);
	if (!annot) return null;
	try {
		return fn(annot);
	} finally {
		ctx.P.FPDFPage_CloseAnnot(annot);
	}
}

const fieldName = (ctx: FormContext, annot: number) => utf16(ctx, (b, l) => ctx.P.FPDFAnnot_GetFormFieldName(ctx.form, annot, b, l));
const fieldValue = (ctx: FormContext, annot: number) => utf16(ctx, (b, l) => ctx.P.FPDFAnnot_GetFormFieldValue(ctx.form, annot, b, l));

/** The page's visible widgets, in annotation order (later ones on top). */
export function readWidgets(ctx: FormContext, index: number, page: number): FormWidget[] {
	const { P, form } = ctx;
	const out: FormWidget[] = [];
	const n = P.FPDFPage_GetAnnotCount(page);
	if (n <= 0) return out;
	const mem = malloc(ctx, 16);
	try {
		for (let i = 0; i < n; i++) {
			withAnnot(ctx, page, i, (annot) => {
				if (P.FPDFAnnot_GetSubtype(annot) !== ANNOT_WIDGET) return;
				if (P.FPDFAnnot_GetFlags(annot) & (ANNOT_HIDDEN | ANNOT_NOVIEW)) return;
				if (!P.FPDFAnnot_GetRect(annot, mem)) return;
				const r = new Float32Array(ctx.heap().buffer, mem, 4);
				const [l, t, rr, b] = [r[0]!, r[1]!, r[2]!, r[3]!];
				const a = ctx.toPage(index, l, t);
				const c = ctx.toPage(index, rr, b);
				const rect: Box = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])];
				const kind = FIELD_KINDS[P.FPDFAnnot_GetFormFieldType(form, annot)] ?? "unknown";
				const flags = P.FPDFAnnot_GetFormFieldFlags(form, annot);
				const w: FormWidget = { index: i, rect, kind, name: fieldName(ctx, annot), value: fieldValue(ctx, annot), readOnly: !!(flags & FIELD_READONLY) };
				if (kind === "text") {
					if (flags & TEXT_MULTILINE) w.multiline = true;
					if (flags & TEXT_PASSWORD) w.password = true;
				}
				if (kind === "combo" || kind === "list") {
					const count = P.FPDFAnnot_GetOptionCount(form, annot);
					w.options = [];
					for (let k = 0; k < count; k++) w.options.push(utf16(ctx, (b, len) => P.FPDFAnnot_GetOptionLabel(form, annot, k, b, len)));
				}
				if (kind === "text" || kind === "combo") {
					if (P.FPDFAnnot_GetFontSize(form, annot, mem)) w.fontSize = new Float32Array(ctx.heap().buffer, mem, 1)[0]!;
				}
				out.push(w);
			});
		}
	} finally {
		free(ctx, mem);
	}
	return out;
}

/** Index of the widget under a page point (top-left origin), or -1. */
function annotAt(ctx: FormContext, index: number, page: number, x: number, y: number): number {
	const [ux, uy] = ctx.toUser(index, x, y);
	const pt = malloc(ctx, 8);
	try {
		const f = new Float32Array(ctx.heap().buffer, pt, 2);
		f[0] = ux;
		f[1] = uy;
		const annot = ctx.P.FPDFAnnot_GetFormFieldAtPoint(ctx.form, page, pt);
		if (!annot) return -1;
		const i = ctx.P.FPDFPage_GetAnnotIndex(page, annot);
		ctx.P.FPDFPage_CloseAnnot(annot);
		return i;
	} finally {
		free(ctx, pt);
	}
}

/**
 * Applies `op`. With `report`, returns the fields whose value it changed
 * (name and new value); a button press may change any field, so it reports `reset`.
 */
export function applyFormOp(ctx: FormContext, op: FormOp, report: boolean): { changed: { name: string; value: string }[]; reset: boolean } {
	const { P, form } = ctx;
	return ctx.withPage(op.page, (page) => {
		const target = op.k === "click" ? annotAt(ctx, op.page, page, op.x, op.y) : op.index;
		const read = () => (target >= 0 ? withAnnot(ctx, page, target, (a) => ({ name: fieldName(ctx, a), value: fieldValue(ctx, a), kind: FIELD_KINDS[P.FPDFAnnot_GetFormFieldType(form, a)] })) : null);
		const before = report ? read() : null;
		if (op.k === "click") {
			const [ux, uy] = ctx.toUser(op.page, op.x, op.y);
			P.FORM_OnMouseMove(form, page, op.mods, ux, uy);
			P.FORM_OnLButtonDown(form, page, op.mods, ux, uy);
			P.FORM_OnLButtonUp(form, page, op.mods, ux, uy);
		} else if (op.k === "text") {
			withAnnot(ctx, page, op.index, (annot) => {
				if (!P.FORM_SetFocusedAnnot(form, annot)) return;
				P.FORM_SelectAllText(form, page);
				if (op.value) {
					const s = wide(ctx, op.value);
					P.FORM_ReplaceSelection(form, page, s);
					free(ctx, s);
				} else P.FORM_OnChar(form, page, BACKSPACE, 0);
			});
		} else {
			withAnnot(ctx, page, op.index, (annot) => {
				if (P.FORM_SetFocusedAnnot(form, annot)) P.FORM_SetIndexSelected(form, page, op.option, true);
			});
		}
		// Committing here keeps no focus between edits: the next one starts from the same state in every worker.
		P.FORM_ForceToKillFocus(form);
		const after = report ? read() : null;
		const changed = after && before && after.value !== before.value ? [{ name: after.name, value: after.value }] : [];
		return { changed, reset: after?.kind === "button" };
	});
}

/** The document bytes with its edits (FPDF_SaveAsCopy). */
export function saveDocument(ctx: FormContext): Uint8Array {
	const { P } = ctx;
	const writer = P.PDFiumExt_OpenFileWriter();
	try {
		if (!P.PDFiumExt_SaveAsCopy(ctx.doc, writer)) throw new Error("FPDF_SaveAsCopy failed");
		const size = P.PDFiumExt_GetFileWriterSize(writer);
		const buf = malloc(ctx, size);
		try {
			P.PDFiumExt_GetFileWriterData(writer, buf, size);
			return ctx.heap().slice(buf, buf + size);
		} finally {
			free(ctx, buf);
		}
	} finally {
		P.PDFiumExt_CloseFileWriter(writer);
	}
}
