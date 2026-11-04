// Content editing on a PDFium document. Every raster worker applies the same ops in the
// same order, so object indices stay in step across workers without sharing memory.
// Coordinates are page points with a top-left origin (as displayed), like the rest of the protocol.

import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { EditOp, EditOutcome, PageObject, StdFont } from "./protocol";

const FPDF_PAGEOBJ_TEXT = 1;
const FPDF_ANNOT_REDACT = 28;
const FPDF_INCREMENTAL = 1;
const FPDF_NO_INCREMENTAL = 2;
const FONT_FIXED = 1;
const FONT_SERIF = 2;
const FONT_ITALIC = 64;
const OBJ_TYPES: PageObject["type"][] = ["unknown", "text", "path", "image", "shading", "form"];

type Xy = [number, number];

export interface EditHost {
	P: WrappedPdfiumModule;
	doc(): number;
	pageCount(): number;
	/** loaded page handle, kept loaded while it has edits */
	page(index: number): number;
	/** page points (top-left) -> PDF user space, and back */
	toUser(index: number, x: number, y: number): Xy;
	toPage(index: number, x: number, y: number): Xy;
	/** page `index` changed size or orientation: drop cached sizes and transforms */
	resized(index: number): void;
	/** page `index` is gone: close its handle and shift later pages down */
	removed(index: number): void;
	/** close every page and reopen the original document (replay starts from here) */
	reopen(): void;
}

interface Entry {
	op: EditOp;
	/** exact inverse, when cheap; otherwise undo replays the log from the original */
	undo?: () => void;
	redo?: () => void;
	outcome: EditOutcome;
}

let P: WrappedPdfiumModule;
const heap = () => (P.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
const malloc = (n: number) => P.pdfium.wasmExports.malloc(n);
const free = (p: number) => P.pdfium.wasmExports.free(p);

function wide(text: string): number {
	const ptr = malloc((text.length + 1) * 2);
	const u16 = new Uint16Array(heap().buffer, ptr, text.length + 1);
	for (let i = 0; i < text.length; i++) u16[i] = text.charCodeAt(i);
	u16[text.length] = 0;
	return ptr;
}

type Box = [number, number, number, number];
const union = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

function readBytes(fn: (buf: number, len: number) => number, utf16: boolean): string {
	const len = fn(0, 0);
	if (len <= 0) return "";
	const buf = malloc(len);
	fn(buf, len);
	const bytes = heap().slice(buf, buf + len);
	free(buf);
	return (utf16 ? new TextDecoder("utf-16le") : new TextDecoder()).decode(bytes).replace(/\0+$/, "");
}

export class Editor {
	private log: Entry[] = [];
	/** entries [0, cursor) are applied */
	private cursor = 0;
	private fonts = new Map<StdFont, number>();
	/** pages with edits not yet written to their content streams */
	private dirty = new Set<number>();
	/** page handles edited this session (kept loaded) */
	readonly edited = new Set<number>();

	private host: EditHost;

	constructor(host: EditHost) {
		this.host = host;
		P = host.P;
	}

	get canUndo() {
		return this.cursor > 0;
	}
	get canRedo() {
		return this.cursor < this.log.length;
	}
	get depth() {
		return this.cursor;
	}

	apply(op: EditOp): EditOutcome {
		const entry = this.run(op);
		this.log.length = this.cursor;
		this.log.push(entry);
		this.cursor++;
		return entry.outcome;
	}

	undo(): EditOutcome | null {
		if (!this.cursor) return null;
		const entry = this.log[--this.cursor]!;
		if (entry.undo) entry.undo();
		else this.replay();
		return { ...entry.outcome, undone: true };
	}

	redo(): EditOutcome | null {
		if (this.cursor >= this.log.length) return null;
		const entry = this.log[this.cursor]!;
		if (entry.redo) entry.redo();
		else this.log[this.cursor] = this.run(entry.op);
		this.cursor++;
		return entry.outcome;
	}

	/** Reopens the original and re-applies entries [0, cursor): exact, and rebuilds every inverse. */
	private replay() {
		this.fonts.clear();
		this.dirty.clear();
		this.edited.clear();
		this.host.reopen();
		for (let i = 0; i < this.cursor; i++) this.log[i] = this.run(this.log[i]!.op);
		// handles in entries past the cursor died with the old document: redo re-runs their ops
		for (let i = this.cursor; i < this.log.length; i++) this.log[i] = { op: this.log[i]!.op, outcome: this.log[i]!.outcome };
	}

	private touch(index: number) {
		this.dirty.add(index);
		this.edited.add(index);
	}

	private run(op: EditOp): Entry {
		switch (op.kind) {
			case "set-text":
				return this.setText(op);
			case "add-text":
				return this.addText(op);
			case "delete-object":
				return this.deleteObject(op);
			case "move-object":
				return this.moveObject(op);
			case "rotate-page":
				return this.rotatePage(op);
			case "delete-page":
				return this.deletePage(op);
			case "insert-page":
				return this.insertPage(op);
			case "redact":
				return this.redact(op);
		}
	}

	// ------------------------------------------------------------ objects

	objects(index: number): PageObject[] {
		const page = this.host.page(index);
		const tp = P.FPDFText_LoadPage(page);
		const mem = malloc(16);
		const out: PageObject[] = [];
		try {
			const n = P.FPDFPage_CountObjects(page);
			for (let i = 0; i < n; i++) {
				const obj = P.FPDFPage_GetObject(page, i);
				const type = OBJ_TYPES[P.FPDFPageObj_GetType(obj)] ?? "unknown";
				const box = this.bounds(index, obj, mem);
				if (!box) continue;
				const entry: PageObject = { index: i, type, box };
				if (type === "text") {
					entry.text = readBytes((b, l) => P.FPDFTextObj_GetText(obj, tp, b, l), true);
					P.FPDFTextObj_GetFontSize(obj, mem);
					entry.size = new Float32Array(heap().buffer, mem, 1)[0]!;
					const font = P.FPDFTextObj_GetFont(obj);
					entry.font = readBytes((b, l) => P.FPDFFont_GetBaseFontName(font, b, l), false);
					entry.embedded = P.FPDFFont_GetIsEmbedded(font) === 1;
					entry.invisible = P.FPDFTextObj_GetTextRenderMode(obj) === 3;
				}
				out.push(entry);
			}
		} finally {
			free(mem);
			P.FPDFText_ClosePage(tp);
		}
		return out;
	}

	private bounds(index: number, obj: number, mem: number): PageObject["box"] | null {
		if (!P.FPDFPageObj_GetBounds(obj, mem, mem + 4, mem + 8, mem + 12)) return null;
		const [l, b, r, t] = new Float32Array(heap().buffer, mem, 4);
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (const [x, y] of [
			[l!, b!],
			[r!, b!],
			[l!, t!],
			[r!, t!],
		] as const) {
			const [px, py] = this.host.toPage(index, x, y);
			x0 = Math.min(x0, px);
			y0 = Math.min(y0, py);
			x1 = Math.max(x1, px);
			y1 = Math.max(y1, py);
		}
		return [x0, y0, x1, y1];
	}

	private object(index: number, obj: number): { page: number; handle: number } {
		const page = this.host.page(index);
		const handle = P.FPDFPage_GetObject(page, obj);
		if (!handle) throw new Error(`no object ${obj} on page ${index}`);
		return { page, handle };
	}

	// ------------------------------------------------------------ text

	private stdFont(name: StdFont) {
		let font = this.fonts.get(name);
		if (!font) {
			font = P.FPDFText_LoadStandardFont(this.host.doc(), name);
			if (!font) throw new Error(`no standard font ${name}`);
			this.fonts.set(name, font);
		}
		return font;
	}

	/** The standard-14 face closest to a font, from its flags, weight and name. */
	private closestStd(font: number): StdFont {
		const flags = P.FPDFFont_GetFlags(font);
		const name = readBytes((b, l) => P.FPDFFont_GetBaseFontName(font, b, l), false).toLowerCase();
		const bold = P.FPDFFont_GetWeight(font) >= 600 || /bold|black|heavy|semibold|cmbx/.test(name);
		const italic = (flags & FONT_ITALIC) !== 0 || /italic|oblique|cmti|cmmi/.test(name);
		const mono = (flags & FONT_FIXED) !== 0 || /courier|mono|cmtt|consol/.test(name);
		const serif = !mono && ((flags & FONT_SERIF) !== 0 || /times|serif|roman|cmr|nimbusrom|garamond|georgia|minion/.test(name)) && !/sans|arial|helvetica/.test(name);
		if (mono) return bold ? (italic ? "Courier-BoldOblique" : "Courier-Bold") : italic ? "Courier-Oblique" : "Courier";
		if (serif) return bold ? (italic ? "Times-BoldItalic" : "Times-Bold") : italic ? "Times-Italic" : "Times-Roman";
		return bold ? (italic ? "Helvetica-BoldOblique" : "Helvetica-Bold") : italic ? "Helvetica-Oblique" : "Helvetica";
	}

	/** Whether `font` can show `text`: encode it on a probe object and read it back through a text page. */
	private encodes(index: number, font: number, size: number, text: string): boolean {
		if (!text.trim()) return true;
		const page = this.host.page(index);
		const probe = P.FPDFPageObj_CreateTextObj(this.host.doc(), font, size);
		if (!probe) return false;
		const w = wide(text);
		const ok = P.FPDFText_SetText(probe, w);
		free(w);
		if (!ok) {
			P.FPDFPageObj_Destroy(probe);
			return false;
		}
		P.FPDFPage_InsertObject(page, probe);
		const tp = P.FPDFText_LoadPage(page);
		const back = readBytes((b, l) => P.FPDFTextObj_GetText(probe, tp, b, l), true);
		// a subset can map a char yet carry no outline for it: every visible char needs a non-empty glyph box
		let inked = true;
		const box = malloc(32);
		const n = P.FPDFText_CountChars(tp);
		for (let i = 0; i < n && inked; i++) {
			if (P.FPDFText_GetTextObject(tp, i) !== probe) continue;
			const u = P.FPDFText_GetUnicode(tp, i);
			if (u <= 32 || P.FPDFText_IsGenerated(tp, i)) continue;
			if (!P.FPDFText_GetCharBox(tp, i, box, box + 8, box + 16, box + 24)) continue;
			const [l, r, b, t] = new Float64Array(heap().buffer, box, 4);
			if (r! - l! <= 0 || t! - b! <= 0) inked = false;
		}
		free(box);
		P.FPDFText_ClosePage(tp);
		P.FPDFPage_RemoveObject(page, probe);
		P.FPDFPageObj_Destroy(probe);
		const norm = (s: string) => s.replace(/\s+/g, "");
		return inked && norm(back) === norm(text);
	}

	private setText(op: Extract<EditOp, { kind: "set-text" }>): Entry {
		const { page, handle } = this.object(op.page, op.obj);
		if (P.FPDFPageObj_GetType(handle) !== FPDF_PAGEOBJ_TEXT) throw new Error("not a text object");
		const font = P.FPDFTextObj_GetFont(handle);
		const mem = malloc(24);
		P.FPDFTextObj_GetFontSize(handle, mem);
		const size = new Float32Array(heap().buffer, mem, 1)[0]!;
		const before = this.bounds(op.page, handle, mem)!;
		const absorbed = (op.absorb ?? []).filter((i) => i !== op.obj).map((i) => P.FPDFPage_GetObject(page, i)).filter(Boolean);
		let region: Box = before;
		for (const h of absorbed) region = union(region, this.bounds(op.page, h, mem) ?? region);
		this.touch(op.page);
		let outcome: EditOutcome;
		let entry: Entry;
		if (this.encodes(op.page, font, size, op.text)) {
			// In place keeps the graphics state, clip and marked content; the original kerning cannot come back, so undo replays.
			const w = wide(op.text);
			P.FPDFText_SetText(handle, w);
			free(w);
			outcome = { pages: [op.page], structure: false, font: "same" };
			entry = { op, outcome };
		} else {
			const std = this.closestStd(font);
			const sub = this.stdFont(std);
			if (!this.encodes(op.page, sub, size, op.text)) {
				free(mem);
				throw new Error(`neither the original font nor ${std} can encode this text (needs an embedded Unicode font)`);
			}
			const repl = P.FPDFPageObj_CreateTextObj(this.host.doc(), sub, size);
			const w = wide(op.text);
			P.FPDFText_SetText(repl, w);
			free(w);
			P.FPDFPageObj_GetMatrix(handle, mem);
			P.FPDFPageObj_SetMatrix(repl, mem);
			P.FPDFPageObj_GetFillColor(handle, mem, mem + 4, mem + 8, mem + 12);
			const c = new Uint32Array(heap().buffer, mem, 4);
			P.FPDFPageObj_SetFillColor(repl, c[0]!, c[1]!, c[2]!, c[3]!);
			P.FPDFTextObj_SetTextRenderMode(repl, P.FPDFTextObj_GetTextRenderMode(handle));
			P.FPDFPage_RemoveObject(page, handle);
			P.FPDFPage_InsertObjectAtIndex(page, repl, op.obj);
			outcome = { pages: [op.page], structure: false, font: std };
			const swap = (out: number, inn: number) => () => {
				P.FPDFPage_RemoveObject(page, out);
				P.FPDFPage_InsertObjectAtIndex(page, inn, op.obj);
				this.touch(op.page);
			};
			entry = absorbed.length ? { op, outcome } : { op, outcome, undo: swap(repl, handle), redo: swap(handle, repl) };
		}
		const edited = P.FPDFPage_GetObject(page, op.obj);
		// the rest of a line split into several objects: its text now lives in the first one
		for (const h of absorbed) P.FPDFPage_RemoveObject(page, h);
		const after = this.bounds(op.page, edited, mem)!;
		free(mem);
		outcome.widthDelta = after[2] - after[0] - (before[2] - before[0]);
		outcome.region = union(region, after);
		return entry;
	}

	private addText(op: Extract<EditOp, { kind: "add-text" }>): Entry {
		const page = this.host.page(op.page);
		const font = this.stdFont(op.font ?? "Helvetica");
		if (!this.encodes(op.page, font, op.size, op.text)) throw new Error(`${op.font ?? "Helvetica"} cannot encode this text (needs an embedded Unicode font)`);
		const obj = P.FPDFPageObj_CreateTextObj(this.host.doc(), font, op.size);
		const w = wide(op.text);
		P.FPDFText_SetText(obj, w);
		free(w);
		const [r, g, b] = op.color ?? [0, 0, 0];
		P.FPDFPageObj_SetFillColor(obj, r, g, b, 255);
		// y is the baseline; the text runs along the page as displayed, so undo the page's rotation
		const [ux, uy] = this.host.toUser(op.page, op.x, op.y);
		const [ax, ay] = this.host.toUser(op.page, op.x + 1, op.y);
		const [bx, by] = this.host.toUser(op.page, op.x, op.y - 1);
		P.FPDFPageObj_Transform(obj, ax - ux, ay - uy, bx - ux, by - uy, ux, uy);
		P.FPDFPage_InsertObject(page, obj);
		const index = P.FPDFPage_CountObjects(page) - 1;
		this.touch(op.page);
		const mem = malloc(16);
		const region = this.bounds(op.page, obj, mem) ?? undefined;
		free(mem);
		const outcome: EditOutcome = { pages: [op.page], structure: false, font: op.font ?? "Helvetica", index, region };
		return {
			op,
			outcome,
			undo: () => {
				P.FPDFPage_RemoveObject(page, obj);
				this.touch(op.page);
			},
			redo: () => {
				P.FPDFPage_InsertObjectAtIndex(page, obj, index);
				this.touch(op.page);
			},
		};
	}

	private deleteObject(op: Extract<EditOp, { kind: "delete-object" }>): Entry {
		const { page, handle } = this.object(op.page, op.obj);
		const mem = malloc(16);
		const region = this.bounds(op.page, handle, mem) ?? undefined;
		free(mem);
		P.FPDFPage_RemoveObject(page, handle);
		this.touch(op.page);
		return {
			op,
			outcome: { pages: [op.page], structure: false, region },
			undo: () => {
				P.FPDFPage_InsertObjectAtIndex(page, handle, op.obj);
				this.touch(op.page);
			},
			redo: () => {
				P.FPDFPage_RemoveObject(page, handle);
				this.touch(op.page);
			},
		};
	}

	private moveObject(op: Extract<EditOp, { kind: "move-object" }>): Entry {
		const { handle } = this.object(op.page, op.obj);
		const [ox, oy] = this.host.toUser(op.page, 0, 0);
		const [mx, my] = this.host.toUser(op.page, op.dx, op.dy);
		const tx = mx - ox;
		const ty = my - oy;
		const move = (s: number) => () => {
			P.FPDFPageObj_Transform(handle, 1, 0, 0, 1, s * tx, s * ty);
			this.touch(op.page);
		};
		const mem = malloc(16);
		const from = this.bounds(op.page, handle, mem);
		move(1)();
		const to = this.bounds(op.page, handle, mem);
		free(mem);
		const region = from && to ? union(from, to) : undefined;
		return { op, outcome: { pages: [op.page], structure: false, region }, undo: move(-1), redo: move(1) };
	}

	// ------------------------------------------------------------ pages

	private rotatePage(op: Extract<EditOp, { kind: "rotate-page" }>): Entry {
		const page = this.host.page(op.page);
		const turn = (q: number) => () => {
			P.FPDFPage_SetRotation(page, (((P.FPDFPage_GetRotation(page) + q) % 4) + 4) % 4);
			this.host.resized(op.page);
			this.edited.add(op.page);
		};
		turn(op.quarter)();
		return { op, outcome: { pages: [op.page], structure: false, resized: true }, undo: turn(-op.quarter), redo: turn(op.quarter) };
	}

	private deletePage(op: Extract<EditOp, { kind: "delete-page" }>): Entry {
		if (this.host.pageCount() <= 1) throw new Error("cannot delete the only page");
		this.host.removed(op.page);
		P.FPDFPage_Delete(this.host.doc(), op.page);
		this.shift(op.page, -1);
		return { op, outcome: { pages: [], structure: true } };
	}

	private insertPage(op: Extract<EditOp, { kind: "insert-page" }>): Entry {
		const page = P.FPDFPage_New(this.host.doc(), op.at, op.w, op.h);
		if (!page) throw new Error("could not insert a page");
		P.FPDF_ClosePage(page);
		this.shift(op.at, 1);
		return { op, outcome: { pages: [], structure: true } };
	}

	private shift(from: number, by: number) {
		const moved = (set: Set<number>) => new Set([...set].filter((i) => by > 0 || i !== from).map((i) => (i >= from ? i + by : i)));
		const d = moved(this.dirty);
		const e = moved(this.edited);
		this.dirty.clear();
		this.edited.clear();
		for (const i of d) this.dirty.add(i);
		for (const i of e) this.edited.add(i);
	}

	/** True redaction: removes the text, image pixels and paths under `rect`, then paints it black. */
	private redact(op: Extract<EditOp, { kind: "redact" }>): Entry {
		const page = this.host.page(op.page);
		const [l, t, r, b] = op.rect;
		const p = [this.host.toUser(op.page, l, t), this.host.toUser(op.page, r, b)];
		const annot = P.FPDFPage_CreateAnnot(page, FPDF_ANNOT_REDACT);
		if (!annot) throw new Error("could not create a redact annotation");
		const mem = malloc(16);
		const f = new Float32Array(heap().buffer, mem, 4);
		f[0] = Math.min(p[0]![0], p[1]![0]);
		f[1] = Math.max(p[0]![1], p[1]![1]);
		f[2] = Math.max(p[0]![0], p[1]![0]);
		f[3] = Math.min(p[0]![1], p[1]![1]);
		const [f0, f1, f2, f3] = [f[0]!, f[1]!, f[2]!, f[3]!];
		P.FPDFAnnot_SetRect(annot, mem);
		free(mem);
		P.FPDFPage_CloseAnnot(annot);
		const ok = P.EPDFPage_ApplyRedactions(page);
		if (!ok) throw new Error("redaction failed");
		const box = P.FPDFPageObj_CreateNewRect(f0, f3, f2 - f0, f1 - f3);
		P.FPDFPageObj_SetFillColor(box, 0, 0, 0, 255);
		P.FPDFPath_SetDrawMode(box, 1, false);
		P.FPDFPage_InsertObject(page, box);
		this.touch(op.page);
		return { op, outcome: { pages: [op.page], structure: false, region: op.rect } };
	}

	// ------------------------------------------------------------ save

	/** The edited document as PDF bytes: a full rewrite, or the original plus an incremental update. */
	save(incremental: boolean): Uint8Array {
		for (const index of this.dirty) P.FPDFPage_GenerateContent(this.host.page(index));
		this.dirty.clear();
		const chunks: Uint8Array[] = [];
		const addFunction = (P.pdfium as unknown as { addFunction: (f: (...a: number[]) => number, sig: string) => number; removeFunction: (f: number) => void });
		const fn = addFunction.addFunction((_self: number, data: number, size: number) => {
			chunks.push(heap().slice(data, data + size));
			return 1;
		}, "iiii");
		// FPDF_FILEWRITE { int version; int (*WriteBlock)(FPDF_FILEWRITE*, const void*, unsigned long); }
		const writer = malloc(8);
		const v = new Int32Array(heap().buffer, writer, 2);
		v[0] = 1;
		v[1] = fn;
		try {
			if (!P.FPDF_SaveAsCopy(this.host.doc(), writer, incremental ? FPDF_INCREMENTAL : FPDF_NO_INCREMENTAL)) throw new Error("PDFium could not save the document");
		} finally {
			free(writer);
			addFunction.removeFunction(fn);
		}
		let n = 0;
		for (const c of chunks) n += c.length;
		const out = new Uint8Array(n);
		n = 0;
		for (const c of chunks) {
			out.set(c, n);
			n += c.length;
		}
		return out;
	}
}

