// Page text as geometry: characters, lines, hit testing and selection rects.
// Everything works on PDFium's char boxes; the DOM is never measured.

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Line {
	/** first char index (inclusive) */
	start: number;
	/** last char index (exclusive), excluding trailing generated newline chars */
	end: number;
	l: number;
	t: number;
	r: number;
	b: number;
	/** right-to-left (its first strong char is Hebrew/Arabic/...), or vertical (top to bottom) */
	dir?: "rtl" | "ttb";
}

export interface TextPoint {
	page: number;
	/** caret position: before char `index` */
	index: number;
}

import { buildHaystack, type Haystack, type SearchOptions } from "./search";

const NEWLINE = new Set([0x0a, 0x0d]);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** strong right-to-left scripts (Unicode bidi classes R and AL) */
const RTL = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;
/** strong left-to-right: letters of every other script */
const STRONG_LTR = /(?![\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}])\p{L}/u;

/** How selected text is copied, like @anaralabs/lector's `copyOptions`. */
export interface SelectionTextOptions {
	/** "preserve" (default) keeps line breaks; "space" joins lines with a space */
	lineBreaks?: "preserve" | "space";
	/** join words hyphenated across a line break ("pro-⏎gram" → "program"); default false */
	ignoreHyphenation?: boolean;
}

export class PageText {
	readonly lines: Line[] = [];
	/** char index -> line index (-1 for chars outside any line) */
	private lineOf: Int32Array;

	constructor(
		readonly codes: Uint32Array,
		readonly boxes: Float32Array,
	) {
		this.lineOf = new Int32Array(codes.length).fill(-1);
		this.buildLines();
	}

	get length() {
		return this.codes.length;
	}

	private hasBox(i: number) {
		const b = this.boxes;
		return b[i * 4 + 2]! > b[i * 4]! || b[i * 4 + 3]! > b[i * 4 + 1]!;
	}

	/**
	 * Groups chars into lines from their boxes, in PDFium's (logical) order.
	 * Horizontal lines break when a char leaves the line's band or jumps back
	 * against the reading direction (a new column). A line whose second char
	 * sits below the first, in the same column, is vertical (CJK top to
	 * bottom) and continues while chars keep going down that column.
	 */
	private buildLines() {
		const { codes, boxes } = this;
		let line: Line | null = null;
		/** the line's direction is settled (first strong char seen / orientation known) */
		let dirSet = false;
		let lastT = 0;
		const close = () => {
			if (line) this.lines.push(line);
			line = null;
		};
		for (let i = 0; i < codes.length; i++) {
			if (NEWLINE.has(codes[i]!)) {
				close();
				continue;
			}
			if (!this.hasBox(i)) {
				// Generated space: belongs to the current line, adds no geometry.
				if (line) {
					line.end = i + 1;
					this.lineOf[i] = this.lines.length;
				}
				continue;
			}
			const l = boxes[i * 4]!;
			const t = boxes[i * 4 + 1]!;
			const r = boxes[i * 4 + 2]!;
			const b = boxes[i * 4 + 3]!;
			const ch = String.fromCodePoint(codes[i]!);
			if (line) {
				const cur: Line = line;
				const h = cur.b - cur.t;
				const w = cur.r - cur.l;
				const vOverlap = Math.min(b, cur.b) - Math.max(t, cur.t);
				const hOverlap = Math.min(r, cur.r) - Math.max(l, cur.l);
				const minH = Math.min(b - t, h);
				const minW = Math.min(r - l, w);
				let breaks: boolean;
				if (cur.end - cur.start === 1 && cur.dir !== "ttb" && hOverlap > minW * 0.5 && vOverlap < minH * 0.5 && t >= cur.t + h * 0.5 && t - cur.b < h) {
					// Second char directly below the first: a vertical line.
					cur.dir = "ttb";
					breaks = false;
				} else if (cur.dir === "ttb") {
					breaks = hOverlap < minW * 0.5 || t < lastT - w * 0.5 || t - cur.b > w * 2;
				} else if (cur.dir === "rtl") {
					// RTL runs move left; digits and Latin inside them may step right a little.
					breaks = vOverlap < minH * 0.5 || l > cur.r + h * 0.5 || r < cur.l - h * 2;
				} else {
					breaks = vOverlap < minH * 0.5 || l < cur.r - h * 2;
				}
				if (breaks) close();
			}
			if (!line) {
				line = { start: i, end: i + 1, l, t, r, b };
				dirSet = false;
			} else {
				line.end = i + 1;
				line.l = Math.min(line.l, l);
				line.t = Math.min(line.t, t);
				line.r = Math.max(line.r, r);
				line.b = Math.max(line.b, b);
			}
			if (!dirSet && line.dir !== "ttb") {
				if (RTL.test(ch)) {
					line.dir = "rtl";
					dirSet = true;
				} else if (STRONG_LTR.test(ch)) dirSet = true;
			}
			lastT = t;
			this.lineOf[i] = this.lines.length;
		}
		close();
	}

	/** Is char `i` right-to-left (Hebrew, Arabic, Syriac, Thaana, N'Ko, ...)? */
	private isRtl(i: number) {
		return RTL.test(String.fromCodePoint(this.codes[i]!));
	}

	/** Is (x, y) on top of a glyph (with a little slack)? Used for the I-beam cursor. */
	isOverText(x: number, y: number) {
		for (const line of this.lines) {
			const pad = (line.b - line.t) * 0.25;
			if (x >= line.l - pad && x <= line.r + pad && y >= line.t - pad && y <= line.b + pad) return true;
		}
		return false;
	}

	/** Nearest caret position to (x, y) in page points. */
	hitTest(x: number, y: number): number {
		if (this.lines.length === 0) return 0;
		let best = this.lines[0]!;
		let bestD = Infinity;
		for (const line of this.lines) {
			const dx = x < line.l ? line.l - x : x > line.r ? x - line.r : 0;
			const dy = y < line.t ? line.t - y : y > line.b ? y - line.b : 0;
			// Distance across lines matters more: prefer the line you are level with
			// (for vertical lines, the column you are in).
			const d = line.dir === "ttb" ? dx * 4 + dy : dy * 4 + dx;
			if (d < bestD) {
				bestD = d;
				best = line;
			}
		}
		return this.caretInLine(best, x, y);
	}

	/**
	 * Caret at a point on a line. Horizontal lines hit-test the glyph under (or
	 * nearest to) x in visual order, then map it to a logical caret: before the
	 * char on its leading half (the left half of an LTR char, the right half of
	 * an RTL one), after it on the trailing half. Mixed runs (Latin in Hebrew,
	 * Hebrew in Latin) are not visually monotonic in logical order, so the
	 * glyph boxes decide, not a logical scan. Vertical lines go top to bottom.
	 */
	private caretInLine(line: Line, x: number, y: number) {
		const { boxes } = this;
		if (line.dir === "ttb") {
			let last = line.start;
			for (let i = line.start; i < line.end; i++) {
				if (!this.hasBox(i)) continue;
				if (y < (boxes[i * 4 + 1]! + boxes[i * 4 + 3]!) / 2) return i;
				last = i + 1;
			}
			return last;
		}
		let best = -1;
		let bestD = Infinity;
		let bestMid = Infinity;
		for (let i = line.start; i < line.end; i++) {
			if (!this.hasBox(i)) continue;
			const l = boxes[i * 4]!;
			const r = boxes[i * 4 + 2]!;
			const d = x < l ? l - x : x > r ? x - r : 0;
			// Loose boxes overlap: among glyphs under the point, the nearest centre wins.
			const mid = Math.abs(x - (l + r) / 2);
			if (d < bestD || (d === bestD && mid < bestMid)) {
				best = i;
				bestD = d;
				bestMid = mid;
			}
		}
		if (best < 0) return line.start;
		const ch = String.fromCodePoint(this.codes[best]!);
		const rtl = this.isRtl(best) || (line.dir === "rtl" && !STRONG_LTR.test(ch) && !/\p{N}/u.test(ch));
		const mid = (boxes[best * 4]! + boxes[best * 4 + 2]!) / 2;
		return (rtl ? x > mid : x < mid) ? best : best + 1;
	}

	/** Selection rects for chars [from, to), one per line, in page points. */
	rects(from: number, to: number): Rect[] {
		const out: Rect[] = [];
		const { boxes } = this;
		for (const line of this.lines) {
			if (line.end <= from || line.start >= to) continue;
			const a = Math.max(from, line.start);
			const z = Math.min(to, line.end);
			if (line.dir === "ttb") {
				let t = Infinity;
				let b = -Infinity;
				for (let i = a; i < z; i++) {
					if (!this.hasBox(i)) continue;
					t = Math.min(t, boxes[i * 4 + 1]!);
					b = Math.max(b, boxes[i * 4 + 3]!);
				}
				if (t < b) out.push({ x: line.l, y: t, w: line.r - line.l, h: b - t });
				continue;
			}
			let l = Infinity;
			let r = -Infinity;
			for (let i = a; i < z; i++) {
				if (!this.hasBox(i)) continue;
				l = Math.min(l, boxes[i * 4]!);
				r = Math.max(r, boxes[i * 4 + 2]!);
			}
			if (l < r) out.push({ x: l, y: line.t, w: r - l, h: line.b - line.t });
		}
		// Consecutive lines meet halfway: loose boxes overlap (translucent
		// fills would double up into stripes) or leave hairline gaps.
		for (let i = 1; i < out.length; i++) {
			const a = out[i - 1]!;
			const b = out[i]!;
			const aBottom = a.y + a.h;
			const lineH = Math.min(a.h, b.h);
			const gap = b.y - aBottom;
			const sameColumn = b.x < a.x + a.w && a.x < b.x + b.w;
			if (!sameColumn || b.y <= a.y || gap > lineH * 0.6) continue;
			const mid = (aBottom + b.y) / 2;
			a.h = mid - a.y;
			b.h = b.y + b.h - mid;
			b.y = mid;
		}
		return out;
	}

	/**
	 * Text of chars [from, to). By default line-end hyphens stay joined (as
	 * PDFium reports them) and line breaks are kept; `options` follow lector's
	 * copy options (SelectionTextOptions).
	 */
	text(from: number, to: number, options: SelectionTextOptions = { ignoreHyphenation: true }) {
		const space = options.lineBreaks === "space";
		let s = "";
		const end = Math.min(to, this.codes.length);
		for (let i = Math.max(0, from); i < end; i++) {
			const c = this.codes[i]!;
			if (c === 0x0d) continue;
			if (c === 0x02) {
				// PDFium's marker for a hyphen it joined across a line break.
				if (!options.ignoreHyphenation) s += space ? "- " : "-\n";
				continue;
			}
			if (c === 0x0a && space) {
				// Chinese/Japanese wrap without a separator; everything else gets a space.
				const prev = s.codePointAt(s.length - 1) ?? 0;
				const next = this.codes[i + 1] ?? 0;
				if (!(CJK.test(String.fromCodePoint(prev)) && CJK.test(String.fromCodePoint(next)))) s += " ";
				continue;
			}
			s += String.fromCodePoint(c || 0x20);
		}
		return s;
	}

	/** All page text (as `text()`), plus the char index of each UTF-16 unit. */
	textWithMap(): { text: string; chars: Int32Array } {
		let s = "";
		const chars: number[] = [];
		for (let i = 0; i < this.codes.length; i++) {
			const c = this.codes[i]!;
			if (c === 0x0d || c === 0x02) continue;
			const ch = String.fromCodePoint(c || 0x20);
			s += ch;
			for (let k = 0; k < ch.length; k++) chars.push(i);
		}
		return { text: s, chars: Int32Array.from(chars) };
	}

	private haystacks = new Map<number, Haystack>();

	/** Folded text for search (see buildHaystack), cached per folding variant. */
	haystack(options: Pick<SearchOptions, "matchDiacritics" | "ignoreHyphenation"> = {}): Haystack {
		const key = (options.matchDiacritics === false ? 1 : 0) | (options.ignoreHyphenation ? 2 : 0);
		let h = this.haystacks.get(key);
		if (!h) this.haystacks.set(key, (h = buildHaystack(this.codes, options)));
		return h;
	}

	/** One entry per line for the hidden DOM text layer (page points). */
	layerLines(): { text: string; x: number; y: number; w: number; h: number; dir?: "rtl" | "ttb" }[] {
		return this.lines.map((line) => ({
			text: this.text(line.start, line.end).replace(/[\r\n]+$/, ""),
			x: line.l,
			y: line.t,
			w: line.r - line.l,
			h: line.b - line.t,
			...(line.dir ? { dir: line.dir } : {}),
		}));
	}

	/** Word boundaries around caret `index`. */
	wordAt(index: number): [number, number] {
		const isWord = (i: number) => i >= 0 && i < this.codes.length && /[\p{L}\p{N}_]/u.test(String.fromCodePoint(this.codes[i]!));
		let a = index;
		let z = index;
		if (!isWord(a) && isWord(a - 1)) a--;
		if (!isWord(a)) return [index, Math.min(index + 1, this.codes.length)];
		while (isWord(a - 1)) a--;
		while (isWord(z)) z++;
		return [a, z];
	}

	lineAt(index: number): [number, number] {
		const li = this.lineOf[Math.min(index, this.codes.length - 1)] ?? -1;
		const line = this.lines[li];
		return line ? [line.start, line.end] : [index, index];
	}
}

export function comparePoints(a: TextPoint, b: TextPoint) {
	return a.page - b.page || a.index - b.index;
}
