// Smart-selection page structure from char boxes; no runtime imports (tests load it in Node).

export interface LayoutLine {
	start: number;
	end: number;
	l: number;
	t: number;
	r: number;
	b: number;
	dir?: "rtl" | "ttb";
}

export interface Box {
	l: number;
	t: number;
	r: number;
	b: number;
}

interface Row extends Box {
	start: number;
	end: number;
	/** median glyph height */
	h: number;
	ttb: boolean;
	rtl: boolean;
	margin: boolean;
	column: number;
	para: number;
}

export interface Column extends Box {
	/** a running header or footer (page numbers, journal lines) */
	margin: boolean;
}

interface Para {
	start: number;
	end: number;
	first: number;
	last: number;
	margin: boolean;
}

interface Flow {
	text: string;
	/** char index of each UTF-16 unit of `text` */
	map: number[];
}

interface Seg {
	start: number;
	end: number;
	word: boolean;
}

export interface SentenceRange {
	start: number;
	end: number;
	/** may begin on the previous page (first body sentence, starts lowercase) */
	openStart: boolean;
	/** may continue on the next page (last body sentence, no closing punctuation) */
	openEnd: boolean;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;
const HYPHENS = new Set([0x2d, 0xad, 0x2010, 0x2011]);
const TERMINAL = /[.!?…‽。！？][\s"'”’»)\]]*$/u;
/** abbreviations a period does not end a sentence after (lowercase, no period) */
const ABBREVIATIONS = new Set(
	(
		"al fig figs eq eqs ref refs sec secs sect ch chap tab tabs no nos vol vols pp p cf vs viz approx ca resp " +
		"dr mr mrs ms prof jr sr st inc ltd corp dept univ ed eds suppl thm lem def prop cor alg app apps ex est " +
		"incl esp fn ser rev trans sp spp ibid cit lit orig ff op pl sing var subsp col cols diag eqn eqns"
	).split(" "),
);
const CITATION = /^\s*(?:\[[\d\s,;–—-]+\]|\([^()]{0,80}?\d{4}[a-z]?\)|\d{1,3}(?:[,–-]\d{1,3})*(?=\s|$))/u;

type SegmenterLike = { segment(s: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> };
const segmenters = new Map<string, SegmenterLike | null>();
function segmenter(granularity: "word" | "sentence"): SegmenterLike | null {
	if (!segmenters.has(granularity)) {
		const Ctor = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => SegmenterLike }).Segmenter;
		segmenters.set(granularity, Ctor ? new Ctor(undefined, { granularity }) : null);
	}
	return segmenters.get(granularity)!;
}

const median = (xs: number[]) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[s.length >> 1]!;
};
const quantile = (xs: number[], q: number) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const xOverlap = (a: Box, b: Box) => Math.min(a.r, b.r) - Math.max(a.l, b.l);

export class PageLayout {
	readonly columns: Column[] = [];
	private rows: Row[] = [];
	private paras: Para[] = [];
	private rowOfLine: Int32Array;
	/** body line height (median glyph height) */
	private unit = 0;
	private flows = new Map<number, Flow>();
	private words = new Map<number, Seg[]>();
	private sentences = new Map<number, Seg[]>();
	private codes: Uint32Array;
	private boxes: Float32Array;
	private lines: readonly LayoutLine[];

	constructor(codes: Uint32Array, boxes: Float32Array, lines: readonly LayoutLine[], pageHeight?: number) {
		this.codes = codes;
		this.boxes = boxes;
		this.lines = lines;
		this.rowOfLine = new Int32Array(lines.length).fill(-1);
		this.buildRows();
		this.markMargins(pageHeight);
		this.buildColumns();
		this.buildParagraphs();
	}

	private hasBox(i: number) {
		const b = this.boxes;
		return b[i * 4 + 2]! > b[i * 4]! || b[i * 4 + 3]! > b[i * 4 + 1]!;
	}

	/** Lines sharing a band (superscripts, split runs) form one visual row. */
	private buildRows() {
		const { lines, boxes } = this;
		for (let li = 0; li < lines.length; li++) {
			const L = lines[li]!;
			const heights: number[] = [];
			for (let i = L.start; i < L.end; i++) if (this.hasBox(i)) heights.push(boxes[i * 4 + 3]! - boxes[i * 4 + 1]!);
			const h = L.dir === "ttb" ? L.r - L.l : median(heights) || L.b - L.t;
			const R = this.rows[this.rows.length - 1];
			if (R && L.dir !== "ttb" && !R.ttb && this.joins(R, L, h)) {
				R.end = L.end;
				R.l = Math.min(R.l, L.l);
				R.t = Math.min(R.t, L.t);
				R.r = Math.max(R.r, L.r);
				R.b = Math.max(R.b, L.b);
				if (L.end - L.start > 2) R.h = Math.max(R.h, h);
			} else {
				this.rows.push({ start: L.start, end: L.end, l: L.l, t: L.t, r: L.r, b: L.b, h, ttb: L.dir === "ttb", rtl: L.dir === "rtl", margin: false, column: -1, para: -1 });
			}
			this.rowOfLine[li] = this.rows.length - 1;
		}
		this.unit = median(this.rows.filter((r) => !r.ttb && r.end - r.start > 3).map((r) => r.h)) || 10;
	}

	private joins(R: Row, L: LayoutLine, h: number) {
		const v = Math.min(L.b, R.b) - Math.max(L.t, R.t);
		if (v < 0.4 * Math.min(h, R.h, L.b - L.t)) return false;
		const H = Math.max(R.h, h);
		return R.rtl ? L.r <= R.l + 0.5 * H && R.l - L.r <= H : L.l >= R.r - 0.5 * H && L.l - R.r <= H;
	}

	/** Running headers/footers: a few rows in the page's outer 8%, set apart by a gap. */
	private markMargins(pageHeight?: number) {
		const rows = this.rows.filter((r) => !r.ttb);
		if (rows.length < 4) return;
		const top = pageHeight ? 0 : Math.min(...rows.map((r) => r.t));
		const bottom = pageHeight ?? Math.max(...rows.map((r) => r.b));
		const band = (bottom - top) * 0.08;
		const gap = this.unit * 0.8;
		const pick = (inBand: (r: Row) => boolean, depth: (r: Row) => number, toward: 1 | -1) => {
			const cand = rows.filter(inBand);
			const rest = rows.filter((r) => !inBand(r));
			cand.sort((a, b) => depth(a) - depth(b));
			while (cand.length) {
				const inner = toward === 1 ? Math.max(...cand.map((r) => r.b)) : Math.min(...cand.map((r) => r.t));
				const body = toward === 1 ? Math.min(...rest.map((r) => r.t)) : Math.max(...rest.map((r) => r.b));
				if (toward * (body - inner) >= gap) break;
				rest.push(cand.pop()!);
			}
			const bands = new Set(cand.map((r) => Math.round(r.t / this.unit)));
			if (cand.length && bands.size <= 3 && rest.length >= 2) for (const r of cand) r.margin = true;
		};
		pick((r) => (r.t + r.b) / 2 < top + band, (r) => r.b - top, 1);
		pick((r) => (r.t + r.b) / 2 > bottom - band, (r) => bottom - r.t, -1);
	}

	/** XY-cut blocks stacked over each other form a column; a block spanning two side-by-side ones is its own. */
	private buildColumns() {
		const body: number[] = [];
		const rows = this.rows;
		for (let i = 0; i < rows.length; i++) if (!rows[i]!.ttb && !rows[i]!.margin) body.push(i);
		const blocks: number[][] = [];
		this.cut(body, blocks);
		const boxes = blocks.map((ids) => this.union(ids));
		const n = boxes.length;
		const same = (a: Box, b: Box) => xOverlap(a, b) >= 0.5 * Math.min(a.r - a.l, b.r - b.l);
		const spans = boxes.map((a, i) => {
			const over = boxes.filter((b, j) => j !== i && same(a, b));
			return over.some((b, j) => over.some((c, k) => k > j && xOverlap(b, c) <= 0));
		});
		const parent = Array.from({ length: n }, (_, i) => i);
		const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
		for (let i = 0; i < n; i++)
			for (let j = i + 1; j < n; j++) if (spans[i] === spans[j] && same(boxes[i]!, boxes[j]!)) parent[find(i)] = find(j);
		const colOf = new Map<number, number>();
		for (let i = 0; i < n; i++) {
			const root = find(i);
			let c = colOf.get(root);
			if (c === undefined) {
				c = this.columns.push({ ...boxes[i]!, margin: false }) - 1;
				colOf.set(root, c);
			}
			const col = this.columns[c]!;
			const b = boxes[i]!;
			col.l = Math.min(col.l, b.l);
			col.t = Math.min(col.t, b.t);
			col.r = Math.max(col.r, b.r);
			col.b = Math.max(col.b, b.b);
			for (const id of blocks[i]!) rows[id]!.column = c;
		}
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i]!;
			if (r.column >= 0) continue;
			const prev = rows[i - 1];
			if (r.ttb && prev?.ttb && prev.column >= 0 && r.r <= prev.l + r.h && prev.l - r.r < r.h * 2) {
				r.column = prev.column;
				const col = this.columns[r.column]!;
				col.l = Math.min(col.l, r.l);
				col.t = Math.min(col.t, r.t);
				col.b = Math.max(col.b, r.b);
				continue;
			}
			r.column = this.columns.push({ l: r.l, t: r.t, r: r.r, b: r.b, margin: r.margin }) - 1;
		}
	}

	private union(ids: number[]): Box {
		const box = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
		for (const id of ids) {
			const r = this.rows[id]!;
			box.l = Math.min(box.l, r.l);
			box.t = Math.min(box.t, r.t);
			box.r = Math.max(box.r, r.r);
			box.b = Math.max(box.b, r.b);
		}
		return box;
	}

	/** Recursive XY-cut: split at the widest vertical gutter, else at the widest horizontal gap. */
	private cut(ids: number[], out: number[][], depth = 0) {
		if (ids.length <= 1 || depth > 64) {
			if (ids.length) out.push(ids);
			return;
		}
		const rows = this.rows;
		const split = (lo: (r: Row) => number, hi: (r: Row) => number, min: number) => {
			const sorted = [...ids].sort((a, b) => lo(rows[a]!) - lo(rows[b]!));
			let reach = -Infinity;
			let best = -1;
			let width = min;
			for (let k = 0; k < sorted.length; k++) {
				const r = rows[sorted[k]!]!;
				if (k > 0 && lo(r) - reach > width) {
					width = lo(r) - reach;
					best = k;
				}
				reach = Math.max(reach, hi(r));
			}
			return best < 0 ? null : [sorted.slice(0, best), sorted.slice(best)];
		};
		const parts =
			split((r) => r.l, (r) => r.r, this.unit * 0.8) ?? split((r) => r.t, (r) => r.b, this.unit * 0.5);
		if (!parts) {
			out.push(ids);
			return;
		}
		for (const part of parts) this.cut(part.sort((a, b) => a - b), out, depth + 1);
	}

	/** Paragraphs from line geometry (gaps, indents, short lines, size changes), never across columns. */
	private buildParagraphs() {
		const { rows } = this;
		const stats = this.columns.map((_, c) => {
			const own = rows.filter((r) => r.column === c && !r.ttb);
			const pitches: number[] = [];
			let prev: Row | null = null;
			for (const r of own) {
				if (prev && r.t > prev.t) pitches.push(r.t - prev.t);
				prev = r;
			}
			const left = quantile(own.map((r) => r.l), 0.2);
			const right = quantile(own.map((r) => r.r), 0.8);
			const full = own.filter((r) => right - r.r < this.unit * 1.5).length;
			return { left, right, pitch: pitches.length >= 3 ? median(pitches) : 0, justified: own.length >= 3 && full >= own.length * 0.6 };
		});
		let first = 0;
		for (let k = 0; k < rows.length; k++) {
			const B = rows[k]!;
			if (k > 0 && !this.breaks(rows[k - 1]!, B, rows[first]!, stats[B.column]!)) continue;
			if (k > 0) this.closePara(first, k - 1);
			first = k;
		}
		if (rows.length) this.closePara(first, rows.length - 1);
	}

	private closePara(first: number, last: number) {
		const index = this.paras.length;
		this.paras.push({ start: this.rows[first]!.start, end: this.rows[last]!.end, first, last, margin: this.rows[first]!.margin });
		for (let k = first; k <= last; k++) this.rows[k]!.para = index;
	}

	private breaks(A: Row, B: Row, first: Row, col: { left: number; right: number; pitch: number; justified: boolean }) {
		if (A.column !== B.column) return true;
		if (A.ttb || B.ttb) return A.ttb !== B.ttb;
		if (B.t < A.t + 0.3 * A.h) return true;
		const h = Math.max(A.h, B.h);
		if (Math.abs(A.h - B.h) > 0.18 * h) return true;
		if (col.pitch ? B.t - A.t > col.pitch * 1.45 && B.t - A.b > 0.3 * h : B.t - A.b > 0.8 * h) return true;
		const indent = B.l - col.left;
		if (indent > 0.8 * h && indent < 8 * h && A.l - col.left < 0.5 * h) return true;
		if (A !== first && A.l - col.left > 0.8 * h && indent < 0.3 * h && first.l - col.left < 0.3 * h) return true;
		// a much shorter line before a capital is a heading
		const room = col.right - A.r;
		if (room > (col.justified ? 1.5 * h : 0.15 * (col.right - col.left)) && !this.hyphenEnd(A)) {
			const next = this.firstLetter(B);
			if (TERMINAL.test(this.slice(Math.max(A.start, A.end - 4), A.end))) return !(next && /\p{Ll}/u.test(next));
			const heading = room > (col.justified ? 0.3 : 0.5) * (col.right - col.left);
			if (heading && next && /\p{Lu}/u.test(next)) return true;
		}
		return false;
	}

	private lastGlyph(r: { start: number; end: number }) {
		for (let i = r.end - 1; i >= r.start; i--) if (this.hasBox(i) || this.codes[i] === 0x02) return i;
		return -1;
	}

	private hyphenEnd(r: Row) {
		const i = this.lastGlyph(r);
		return i >= 0 && (this.codes[i] === 0x02 || HYPHENS.has(this.codes[i]!));
	}

	private firstLetter(r: Row) {
		for (let i = r.start; i < r.end; i++) {
			const ch = String.fromCodePoint(this.codes[i]!);
			if (/\p{L}|\p{N}/u.test(ch)) return ch;
			if (this.hasBox(i) && !/[\s"'“‘(\[]/u.test(ch)) return null;
		}
		return null;
	}

	private slice(a: number, z: number) {
		let s = "";
		for (let i = a; i < z; i++) s += String.fromCodePoint(this.codes[i] || 0x20);
		return s;
	}

	private rowAt(index: number) {
		for (let i = Math.min(index, this.codes.length - 1), n = 0; i >= 0 && n < 4; i--, n++) {
			const li = this.lineAt(i);
			if (li >= 0) return this.rowOfLine[li]!;
		}
		return -1;
	}

	/** line containing char i, or -1 (binary search: lines are in char order) */
	private lineAt(i: number) {
		const { lines } = this;
		let lo = 0;
		let hi = lines.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const L = lines[mid]!;
			if (i < L.start) hi = mid - 1;
			else if (i >= L.end) lo = mid + 1;
			else return mid;
		}
		return -1;
	}

	private paraAt(index: number) {
		const r = this.rowAt(index);
		return r < 0 ? -1 : this.rows[r]!.para;
	}

	/** column of line `li` (-1 if unknown) */
	lineColumn(li: number) {
		const r = this.rowOfLine[li] ?? -1;
		return r < 0 ? -1 : this.rows[r]!.column;
	}

	columnAt(index: number) {
		const r = this.rowAt(index);
		return r < 0 ? -1 : this.rows[r]!.column;
	}

	isMarginLine(li: number) {
		const r = this.rowOfLine[li] ?? -1;
		return r >= 0 && this.rows[r]!.margin;
	}

	isMargin(index: number) {
		const r = this.rowAt(index);
		return r >= 0 && this.rows[r]!.margin;
	}

	/** Char ranges of header/footer rows, each including its line break. */
	marginSpans(): [number, number][] {
		const out: [number, number][] = [];
		for (let k = 0; k < this.rows.length; k++) {
			const r = this.rows[k]!;
			if (!r.margin) continue;
			const next = this.rows[k + 1];
			out.push([r.start, next ? next.start : this.codes.length]);
		}
		return out;
	}

	/** Is (x, y) inside column `c`'s box, with `pad` line heights of slack? */
	inColumn(c: number, x: number, y: number, pad = 0.25) {
		const col = this.columns[c];
		if (!col) return false;
		const p = this.unit * pad;
		return x >= col.l - p && x <= col.r + p && y >= col.t - p && y <= col.b + p;
	}

	/** A paragraph as one string for the segmenters, with hyphenated line breaks joined. */
	private flow(p: number): Flow {
		const hit = this.flows.get(p);
		if (hit) return hit;
		const para = this.paras[p]!;
		const { codes } = this;
		let text = "";
		const map: number[] = [];
		const push = (s: string, i: number) => {
			text += s;
			for (let k = 0; k < s.length; k++) map.push(i);
		};
		let joinNext = false;
		for (let k = para.first; k <= para.last; k++) {
			const row = this.rows[k]!;
			if (k > para.first) {
				const prev = text.codePointAt(text.length - 1) ?? 0x20;
				const next = this.firstChar(row);
				const cjk = CJK.test(String.fromCodePoint(prev)) && CJK.test(next);
				if (!joinNext && !cjk && !/\s/u.test(String.fromCodePoint(prev))) push(" ", row.start);
			}
			joinNext = false;
			const last = this.lastGlyph(row);
			for (let i = row.start; i < row.end; i++) {
				const c = codes[i]!;
				if (c === 0x0d || c === 0x0a) continue;
				if (c === 0x02) {
					joinNext = true;
					continue;
				}
				if (i === last && k < para.last && HYPHENS.has(c) && this.joinsAcross(i, this.rows[k + 1]!)) {
					joinNext = true;
					continue;
				}
				push(c === 0 ? " " : String.fromCodePoint(c), i);
			}
		}
		const flow = { text, map };
		this.flows.set(p, flow);
		return flow;
	}

	private firstChar(r: Row) {
		for (let i = r.start; i < r.end; i++) if (this.hasBox(i)) return String.fromCodePoint(this.codes[i]!);
		return " ";
	}

	/** "approa-⏎ches": a letter before the hyphen, a lowercase letter after the break. */
	private joinsAcross(i: number, next: Row) {
		const before = String.fromCodePoint(this.codes[i - 1] ?? 0x20);
		return /\p{L}/u.test(before) && /\p{Ll}/u.test(this.firstChar(next));
	}

	private segments(p: number, granularity: "word" | "sentence"): Seg[] {
		const cache = granularity === "word" ? this.words : this.sentences;
		const hit = cache.get(p);
		if (hit) return hit;
		const { text, map } = this.flow(p);
		const raw: { from: number; to: number; word: boolean }[] = [];
		const seg = segmenter(granularity);
		if (seg) {
			for (const s of seg.segment(text)) raw.push({ from: s.index, to: s.index + s.segment.length, word: !!s.isWordLike });
		} else if (granularity === "word") {
			const re = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|[\p{L}\p{N}\p{M}_'’]+|\s+|./gsu;
			for (let m = re.exec(text); m; m = re.exec(text)) raw.push({ from: m.index, to: m.index + m[0].length, word: WORD_CHAR.test(m[0]) });
		} else {
			const re = /[^.!?。！？]*(?:[.!?。！？]+["'”’)\]]*\s*|$)/gu;
			for (let m = re.exec(text); m && m[0]; m = re.exec(text)) raw.push({ from: m.index, to: m.index + m[0].length, word: false });
		}
		const spans = granularity === "sentence" ? fixSentences(text, raw) : raw;
		const out: Seg[] = [];
		for (const s of spans) {
			let from = s.from;
			let to = s.to;
			if (granularity === "sentence") {
				while (from < to && /\s/u.test(text[from]!)) from++;
				while (to > from && /\s/u.test(text[to - 1]!)) to--;
			}
			if (to <= from) continue;
			out.push({ start: map[from]!, end: map[to - 1]! + 1, word: s.word });
		}
		cache.set(p, out);
		return out;
	}

	/** Word at caret `index`, else the word just before it, else the space/punctuation run there. */
	word(index: number): [number, number] {
		const hit = (i: number) => {
			const p = this.paraAt(i);
			if (p < 0) return null;
			return this.segments(p, "word").find((s) => i >= s.start && i < s.end) ?? null;
		};
		const at = index < this.codes.length ? hit(index) : null;
		if (at?.word) return [at.start, at.end];
		const before = index > 0 ? hit(index - 1) : null;
		if (before?.word) return [before.start, before.end];
		if (at) return [at.start, at.end];
		return [index, Math.min(index + 1, this.codes.length)];
	}

	sentence(index: number): SentenceRange {
		const p = this.paraAt(index) >= 0 ? this.paraAt(index) : this.paraAt(index - 1);
		if (p < 0) return { start: index, end: index, openStart: false, openEnd: false };
		const segs = this.segments(p, "sentence");
		const s =
			segs.find((s) => index >= s.start && index < s.end) ??
			segs.find((s) => index - 1 >= s.start && index - 1 < s.end) ??
			segs.find((s) => s.start >= index) ??
			segs[segs.length - 1];
		if (!s) return { start: index, end: index, openStart: false, openEnd: false };
		const body = this.bodyParas();
		const isFirst = s === segs[0] && p === body[0];
		const isLast = s === segs[segs.length - 1] && p === body[body.length - 1];
		const text = this.slice(s.start, s.end);
		return {
			start: s.start,
			end: s.end,
			openStart: isFirst && /^[^\p{L}]*\p{Ll}/u.test(text),
			openEnd: isLast && !TERMINAL.test(text),
		};
	}

	paragraph(index: number): [number, number] {
		const p = this.paraAt(index) >= 0 ? this.paraAt(index) : this.paraAt(index - 1);
		if (p < 0) return [index, index];
		const para = this.paras[p]!;
		let a = para.start;
		let z = para.end;
		while (a < z && !this.hasBox(a)) a++;
		while (z > a && !this.hasBox(z - 1) && this.codes[z - 1] !== 0x02) z--;
		return [a, z];
	}

	/** First / last body sentence (sentences that cross a page break). */
	edgeSentence(which: "first" | "last"): SentenceRange | null {
		const body = this.bodyParas();
		const p = which === "first" ? body[0] : body[body.length - 1];
		if (p === undefined) return null;
		const segs = this.segments(p, "sentence");
		const s = which === "first" ? segs[0] : segs[segs.length - 1];
		return s ? this.sentence(which === "first" ? s.start : s.end - 1) : null;
	}

	private bodyParas() {
		const out: number[] = [];
		for (let p = 0; p < this.paras.length; p++) if (!this.paras[p]!.margin) out.push(p);
		return out;
	}

	/** Paragraph char ranges (tests, debugging). */
	paragraphs(): [number, number][] {
		return this.paras.map((p) => this.paragraph(p.start));
	}
}

type Span = { from: number; to: number; word: boolean };

/** Unicode sentence breaks, repaired for scholarly prose. */
function fixSentences(text: string, raw: Span[]) {
	const merged: Span[] = [];
	for (const s of raw) {
		const prev = merged[merged.length - 1];
		if (prev && joinsSentence(text.slice(prev.from, prev.to), text.slice(s.from, s.to))) prev.to = s.to;
		else merged.push({ ...s });
	}
	const out: Span[] = [];
	for (const s of merged.flatMap((s) => splitMissed(text, s))) {
		const prev = out[out.length - 1];
		// "growth. [12] Next": the citation belongs to the sentence before it
		const m = prev ? CITATION.exec(text.slice(s.from, s.to)) : null;
		if (prev && m) {
			const rest = text.slice(s.from + m[0].length, s.to).trimStart();
			if (!rest || /^\p{Lu}/u.test(rest)) {
				prev.to = s.from + m[0].length;
				if (rest) out.push({ from: prev.to, to: s.to, word: false });
				continue;
			}
		}
		out.push(s);
	}
	return out;
}

/** Breaks the segmenter misses: "before.[12] Later", "chase). c-Myc", "process. p53". */
function splitMissed(text: string, s: Span): Span[] {
	const re = /\p{L}[.!?]["'”’)]*(?:\[[\d\s,;–—-]+\]|\d{1,3}(?:[,–-]\d{1,3})*)\s+(?=\p{Lu})|[.!?]["'”’)\]]*\s+(?=\p{Ll}[\p{L}\d-]*[\p{Lu}\d])/gu;
	const body = text.slice(s.from, s.to);
	const out: Span[] = [];
	let from = s.from;
	for (let m = re.exec(body); m; m = re.exec(body)) {
		const cut = s.from + m.index + m[0].length;
		const stop = s.from + m.index + m[0].search(/[.!?]/) + 1;
		if (joinsSentence(text.slice(from, stop), text.slice(cut, s.to))) continue;
		out.push({ from, to: cut, word: false });
		from = cut;
	}
	out.push({ from, to: s.to, word: s.word });
	return out;
}

function joinsSentence(prev: string, next: string) {
	const p = prev.trimEnd();
	const n = next.trimStart();
	if (!p || !n) return true;
	if (!TERMINAL.test(p)) return true;
	// a plain lowercase word never starts a sentence (but "c-Myc", "p53", "mRNA" may)
	if (/^\p{Ll}+(?=[\s,;:]|$)/u.test(n)) return true;
	if (!/\.["'”’)\]]*$/u.test(p)) return false;
	const words = p.split(/\s+/);
	const token = words[words.length - 1]!.replace(/^[("'“‘[]+/u, "").replace(/["'”’)\]]+$/u, "");
	const bare = token.slice(0, -1).toLowerCase();
	if (ABBREVIATIONS.has(bare)) return true;
	// i.e., e.g., U.S.
	if (/^(?:\p{L}\.){2,}$/u.test(token)) return true;
	// initials: "J. R. Tolkien", "A. Author and B. Writer", "Smith, J. Doe"
	if (/^\p{Lu}\.$/u.test(token)) {
		const before = words[words.length - 2];
		const after = n.split(/\s+/);
		const initial = (w = "") => /^\p{Lu}\.,?$/u.test(w);
		if (initial(before) || initial(after[0])) return true;
		if (/^\p{Lu}\p{Ll}/u.test(after[0] ?? "") && (before === undefined || before.endsWith(",") || before === "and" || before === "&")) return true;
	}
	return false;
}
