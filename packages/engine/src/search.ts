// Text search: folding (case, ligatures, quotes, optional diacritics and
// hyphenation), exact and fuzzy (bounded edit distance) matching. Matches use
// the same ranking as @anaralabs/lector's searchDocument. Pure functions: the
// core feeds pages in as their text arrives, so results stream.

export interface SearchOptions {
	/** fuzzy matches score at least this (0-1, 1 = exact only; default 0.7, like lector) */
	threshold?: number;
	/** max matches returned per kind (default 100) */
	limit?: number;
	/** false folds Latin, Greek and Cyrillic accents ("resume" finds "résumé"); default true */
	matchDiacritics?: boolean;
	/** join words hyphenated at a line break ("pro-\ngram" matches "program"); default false */
	ignoreHyphenation?: boolean;
	/** only these pages (0-based) */
	pages?: number[];
}

export interface Haystack {
	/** folded text: lower case, whitespace runs collapsed to one space */
	text: string;
	/** char index (as `rects` takes) of each UTF-16 unit of `text` */
	map: Int32Array;
}

const LIGATURES = ["ff", "fi", "fl", "ffi", "ffl", "st", "st"];
const QUOTES: Record<string, string> = {
	"‘": "'",
	"’": "'",
	"‚": "'",
	"‛": "'",
	"′": "'",
	"´": "'",
	"`": "'",
	"“": '"',
	"”": '"',
	"„": '"',
	"‟": '"',
	"″": '"',
	"«": '"',
	"»": '"',
	"‐": "-",
	"‑": "-",
	"‒": "-",
	"–": "-",
	"—": "-",
	"−": "-",
};
const FOLDABLE = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u;
const MARK = /\p{M}/u;
const SPACE = /\s/u;
const LOWER = /\p{Ll}/u;

/** Fold one character (a code point as a string) for matching; "" drops it. */
function foldChar(ch: string, matchDiacritics: boolean, prevBase: string): string {
	const code = ch.codePointAt(0)!;
	if (code === 0x02 || code === 0xad) return ""; // PDFium's line-end hyphen marker, soft hyphen
	if (code >= 0xfb00 && code <= 0xfb06) return LIGATURES[code - 0xfb00]!;
	const q = QUOTES[ch];
	if (q) return q;
	if (!matchDiacritics) {
		// A decomposed accent after a Latin/Greek/Cyrillic letter is dropped.
		if (MARK.test(ch)) return FOLDABLE.test(prevBase) ? "" : ch;
		const d = ch.normalize("NFD");
		if (d.length > 1 && FOLDABLE.test(d[0]!)) ch = d.replace(/\p{M}+/gu, "");
	}
	return ch.toLowerCase();
}

/**
 * Folded text of a page's chars with a char map. `codes` are PDFium code
 * points (generated spaces and \r\n line breaks included).
 */
export function buildHaystack(codes: Uint32Array, options: Pick<SearchOptions, "matchDiacritics" | "ignoreHyphenation"> = {}): Haystack {
	const matchDiacritics = options.matchDiacritics !== false;
	let text = "";
	const map: number[] = [];
	let space = false;
	let prevBase = "";
	const n = codes.length;
	for (let i = 0; i < n; i++) {
		const c = codes[i]!;
		const ch = String.fromCodePoint(c || 0x20);
		if (SPACE.test(ch)) {
			if (!space && text.length > 0) {
				text += " ";
				map.push(i);
			}
			space = true;
			continue;
		}
		if (options.ignoreHyphenation && (c === 0x2d || c === 0x2010)) {
			// A hyphen, then whitespace containing a line break, then a lower-case letter.
			let j = i + 1;
			let br = false;
			while (j < n && SPACE.test(String.fromCodePoint(codes[j]! || 0x20))) {
				if (codes[j] === 0x0a || codes[j] === 0x0d) br = true;
				j++;
			}
			if (br && j < n && LOWER.test(String.fromCodePoint(codes[j]!))) {
				i = j - 1;
				continue;
			}
		}
		const folded = foldChar(ch, matchDiacritics, prevBase);
		if (!MARK.test(ch)) prevBase = ch;
		if (!folded) continue;
		space = false;
		text += folded;
		for (let k = 0; k < folded.length; k++) map.push(i);
	}
	return { text, map: Int32Array.from(map) };
}

/** The query folded like page text. */
export function foldQuery(query: string, options: Pick<SearchOptions, "matchDiacritics"> = {}) {
	const codes = Uint32Array.from(Array.from(query.trim(), (c) => c.codePointAt(0)!));
	return buildHaystack(codes, { matchDiacritics: options.matchDiacritics }).text.trim();
}

/** Edit distance of `query` against text at `offset` (same length), giving up past `max`. Two reused rows, band only. */
export function boundedDistance(query: string, max: number) {
	const length = query.length;
	let previous = new Float64Array(length + 1);
	let current = new Float64Array(length + 1);
	const exceeded = max + 1;
	return (text: string, offset: number): number => {
		const size = Math.min(length, text.length - offset);
		if (length - size > max) return exceeded;
		for (let j = 0; j <= length; j++) previous[j] = j;
		for (let i = 1; i <= size; i++) {
			const start = Math.max(1, i - max);
			const end = Math.min(length, i + max);
			current[0] = i;
			if (start > 1) current[start - 1] = exceeded;
			let minimum = exceeded;
			const code = text.charCodeAt(offset + i - 1);
			for (let j = start; j <= end; j++) {
				const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (query.charCodeAt(j - 1) === code ? 0 : 1));
				current[j] = value;
				minimum = Math.min(minimum, value);
			}
			if (end < length) current[end + 1] = exceeded;
			if (minimum > max) return exceeded;
			[previous, current] = [current, previous];
		}
		return previous[length]!;
	};
}

/** A match in folded-text offsets: [start, end) of `text`, which may run into the next page's head. */
export interface RawMatch {
	start: number;
	end: number;
	score: number;
}

/**
 * Exact then fuzzy matches starting on this page. `text` is the page's folded
 * text, optionally followed by the next page's head so matches can cross the
 * page break; matches must start before `pageEnd`.
 */
export function matchPage(text: string, pageEnd: number, query: string, maxDistance: number, distance: ReturnType<typeof boundedDistance> | null) {
	const exact: RawMatch[] = [];
	const fuzzy: RawMatch[] = [];
	const starts: number[] = [];
	for (let at = text.indexOf(query); at !== -1 && at < pageEnd; at = text.indexOf(query, at + query.length)) {
		exact.push({ start: at, end: at + query.length, score: 1 });
		starts.push(at);
	}
	if (!distance || maxDistance <= 0) return { exact, fuzzy };
	let index = 0;
	let k = 0;
	while (index < pageEnd) {
		while (k < starts.length && starts[k]! + query.length <= index) k++;
		const s = starts[k];
		if (s !== undefined && index >= s) {
			index = s + query.length;
			continue;
		}
		// A window starting on a space only shifts a word match: skip it.
		if (text.charCodeAt(index) === 0x20) {
			index++;
			continue;
		}
		const edits = distance(text, index);
		if (edits > 0 && edits <= maxDistance) {
			fuzzy.push({ start: index, end: Math.min(text.length, index + query.length), score: 1 - edits / query.length });
			index += query.length;
		} else index++;
	}
	return { exact, fuzzy };
}

/** Keep the best `limit` items by score; ties keep document order. */
export function insertRanked<T extends { score: number }>(list: T[], item: T, limit: number) {
	if (!limit || (list.length === limit && list[limit - 1]!.score >= item.score)) return;
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (list[mid]!.score >= item.score) lo = mid + 1;
		else hi = mid;
	}
	list.splice(lo, 0, item);
	if (list.length > limit) list.pop();
}

/** lector's split: keep exact/fuzzy balance when both exist, fill unused slots. */
export function splitLimit(exactCount: number, fuzzyCount: number, limit: number) {
	const exactLimit = Math.min(exactCount, Math.max(Math.ceil(limit / 2), limit - fuzzyCount));
	return { exactLimit, fuzzyLimit: limit - exactLimit };
}
