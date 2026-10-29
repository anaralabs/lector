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
}

export interface TextPoint {
	page: number;
	/** caret position: before char `index` */
	index: number;
}

const NEWLINE = new Set([0x0a, 0x0d]);

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

	private buildLines() {
		const { codes, boxes } = this;
		let line: Line | null = null;
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
			if (line) {
				const overlap = Math.min(b, line.b) - Math.max(t, line.t);
				const minH = Math.min(b - t, line.b - line.t);
				const jumpedBack = l < line.r - (line.b - line.t) * 2;
				if (overlap < minH * 0.5 || jumpedBack) close();
			}
			if (!line) {
				line = { start: i, end: i + 1, l, t, r, b };
			} else {
				line.end = i + 1;
				line.l = Math.min(line.l, l);
				line.t = Math.min(line.t, t);
				line.r = Math.max(line.r, r);
				line.b = Math.max(line.b, b);
			}
			this.lineOf[i] = this.lines.length;
		}
		close();
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
			// Vertical distance matters more: prefer the line you are level with.
			const d = dy * 4 + dx;
			if (d < bestD) {
				bestD = d;
				best = line;
			}
		}
		return this.caretInLine(best, x);
	}

	private caretInLine(line: Line, x: number) {
		const { boxes } = this;
		let last = line.start;
		for (let i = line.start; i < line.end; i++) {
			if (!this.hasBox(i)) continue;
			const mid = (boxes[i * 4]! + boxes[i * 4 + 2]!) / 2;
			if (x < mid) return i;
			last = i + 1;
		}
		return last;
	}

	/** Selection rects for chars [from, to), one per line, in page points. */
	rects(from: number, to: number): Rect[] {
		const out: Rect[] = [];
		const { boxes } = this;
		for (const line of this.lines) {
			if (line.end <= from || line.start >= to) continue;
			const a = Math.max(from, line.start);
			const z = Math.min(to, line.end);
			let l = Infinity;
			let r = -Infinity;
			for (let i = a; i < z; i++) {
				if (!this.hasBox(i)) continue;
				l = Math.min(l, boxes[i * 4]!);
				r = Math.max(r, boxes[i * 4 + 2]!);
			}
			if (l < r) out.push({ x: l, y: line.t, w: r - l, h: line.b - line.t });
		}
		return out;
	}

	text(from: number, to: number) {
		let s = "";
		for (let i = Math.max(0, from); i < Math.min(to, this.codes.length); i++) {
			const c = this.codes[i]!;
			if (c === 0x0d) continue;
			if (c === 0x02) continue; // PDFium soft-hyphen marker
			s += String.fromCodePoint(c || 0x20);
		}
		return s;
	}

	private search: { haystack: string; map: Int32Array } | null = null;

	/**
	 * Lower-cased page text for substring search, with whitespace collapsed and
	 * line-break hyphens removed. `map[i]` is the char index of haystack[i].
	 */
	searchable() {
		if (this.search) return this.search;
		let haystack = "";
		const map: number[] = [];
		let space = false;
		for (let i = 0; i < this.codes.length; i++) {
			const c = this.codes[i]!;
			if (c === 0x02) continue; // hyphen at a line break: join the word
			const ch = String.fromCodePoint(c || 0x20);
			if (/\s/.test(ch)) {
				if (!space && haystack.length > 0) {
					haystack += " ";
					map.push(i);
				}
				space = true;
				continue;
			}
			space = false;
			for (const lc of ch.toLocaleLowerCase()) {
				haystack += lc;
				map.push(i);
			}
		}
		this.search = { haystack, map: Int32Array.from(map) };
		return this.search;
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
