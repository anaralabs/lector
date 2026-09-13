/** Text offsets always address the original, concatenated PDF.js strings. */
export interface PageText {
	pageNumber: number;
	text: string;
	/** Sorted UTF-16 offsets after items with hasEOL, without inserting characters. */
	lineBreaks?: readonly number[];
}

export interface TextNormalizationOptions {
	/** Preserve accents by default. False folds Latin, Greek and Cyrillic accents. */
	matchDiacritics?: boolean;
	/** Join letter-hyphen-linebreak-lowercase sequences. Defaults to false. */
	ignoreHyphenation?: boolean;
}

// Sparse edits keep mapping storage proportional to changed runs/line breaks,
// rather than allocating two offsets for every character in a long document.
type Edit = {
	start: number;
	end: number;
	sourceStart: number;
	sourceEnd: number;
};
type Replacement = { index: number; length: number; text: string };
export interface NormalizedText {
	text: string;
	maps: Edit[][];
}

function replace(source: NormalizedText, replacements: Iterable<Replacement>) {
	const chunks: string[] = [];
	const edits: Edit[] = [];
	let offset = 0;
	let outputLength = 0;
	for (const replacement of replacements) {
		const { index, length, text } = replacement;
		if (source.text.slice(index, index + length) === text) continue;
		const before = source.text.slice(offset, index);
		chunks.push(before, text);
		outputLength += before.length;
		edits.push({
			start: outputLength,
			end: outputLength + text.length,
			sourceStart: index,
			sourceEnd: index + length,
		});
		outputLength += text.length;
		offset = index + length;
	}
	if (!edits.length) return source;
	chunks.push(source.text.slice(offset));
	return { text: chunks.join(""), maps: [...source.maps, edits] };
}

function* replacements(text: string, pattern: RegExp, value: string) {
	for (const match of text.matchAll(pattern)) {
		yield { index: match.index, length: match[0].length, text: value };
	}
}

function* insertLineBreaks(text: string, lineBreaks: readonly number[]) {
	let previous = -1;
	for (const index of lineBreaks) {
		if (
			!Number.isInteger(index) ||
			index <= previous ||
			index < 0 ||
			index > text.length
		)
			continue;
		previous = index;
		yield { index, length: 0, text: "\n" };
	}
}

const ligatures = ["ff", "fi", "fl", "ffi", "ffl", "st", "st"];
const softHyphen = /\u00ad(?:[^\S\r\n]*\r?\n[^\S\r\n]*(?=\p{L}))?/gu;
const wrappedHyphen =
	/(?<=[\p{L}\p{M}])[-\u2010][^\S\r\n]*\r?\n[^\S\r\n]*(?=\p{Ll})/gu;
const cjkLineBreak =
	/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\r?\n(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu;

export interface SelectionTextOptions {
	/** Preserve line and page breaks by default; space joins single line breaks. */
	lineBreaks?: "preserve" | "space";
	/** Join wrapped words ending in a hard hyphen. Defaults to false. */
	ignoreHyphenation?: boolean;
}

/** Plain text for quotes/copy. Preserve case, accents, punctuation and paragraphs. */
export function normalizeSelectionText(
	text: string,
	options: SelectionTextOptions = {},
) {
	let result = normalizeUnicode(text).replace(softHyphen, "");
	if (options.ignoreHyphenation) result = result.replace(wrappedHyphen, "");
	if (options.lineBreaks === "space") {
		result = result.replace(cjkLineBreak, "").replace(/(?<!\n)\n(?!\n)/g, " ");
	}
	return result;
}
/** Expand typographic ligatures without changing mathematical compatibility symbols. */
export function normalizeUnicode(text: string, matchDiacritics = true) {
	let result = text.replace(
		/[\uFB00-\uFB06]/g,
		(char) => ligatures[char.charCodeAt(0) - 0xfb00]!,
	);
	if (!matchDiacritics) {
		// Do not remove vowel signs, viramas, or other meaningful marks from
		// scripts such as Devanagari; accent folding is intentionally scoped.
		result = result
			.normalize("NFD")
			.replace(
				/([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu,
				"$1",
			);
	}
	return result.normalize("NFC");
}

let segmenter: Intl.Segmenter | undefined;
function* unicodeReplacements(text: string, matchDiacritics: boolean) {
	segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
	// Segment only non-ASCII runs and their possible ASCII base character.
	// One accent near the end of a long page must not segment every word.
	for (const match of text.matchAll(/\p{ASCII}?\P{ASCII}+/gu)) {
		if (normalizeUnicode(match[0], matchDiacritics) === match[0]) continue;
		for (const { segment, index } of segmenter.segment(match[0])) {
			yield {
				index: match.index + index,
				length: segment.length,
				text: normalizeUnicode(segment, matchDiacritics),
			};
		}
	}
}

/** Search representation; rendering and copied/source text are never lowercased. */
export function normalizeSearchText(
	text: string,
	options: TextNormalizationOptions = {},
	lineBreaks: readonly number[] = [],
): NormalizedText {
	let result: NormalizedText = { text, maps: [] };
	if (lineBreaks.length)
		result = replace(result, insertLineBreaks(text, lineBreaks));
	const matchDiacritics = options.matchDiacritics !== false;
	if (normalizeUnicode(result.text, matchDiacritics) !== result.text) {
		result = replace(result, unicodeReplacements(result.text, matchDiacritics));
	}
	// A discretionary hyphen is formatting, including its line continuation.
	result = replace(result, replacements(result.text, softHyphen, ""));
	if (options.ignoreHyphenation) {
		// Hard line-end hyphens may belong to compounds, so joining is opt-in.
		result = replace(result, replacements(result.text, wrappedHyphen, ""));
	}
	// Chinese/Japanese wrapping adds no separator; Korean keeps word breaks.
	result = replace(result, replacements(result.text, cjkLineBreak, ""));
	result = replace(result, replacements(result.text, /\s+/gu, " "));

	// Lowercase as a whole to retain contextual Greek sigma. Only length
	// expansions require another map; ordinary lowercasing keeps offsets.
	const lower = result.text.toLowerCase();
	if (lower.length !== result.text.length) {
		function* caseReplacements(value: string) {
			let index = 0;
			for (const char of value) {
				const folded = char.toLowerCase();
				if (folded.length !== char.length)
					yield { index, length: char.length, text: folded };
				index += char.length;
			}
		}
		result = replace(result, caseReplacements(result.text));
	}
	return { ...result, text: lower };
}

function sourceOffset(edits: Edit[], offset: number, end: boolean) {
	let low = 0;
	let high = edits.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (edits[middle]!.start <= offset) low = middle + 1;
		else high = middle;
	}
	const edit = edits[low - 1];
	if (!edit) return offset + (end ? 1 : 0);
	if (offset < edit.end) return end ? edit.sourceEnd : edit.sourceStart;
	return offset + edit.sourceEnd - edit.end + (end ? 1 : 0);
}

/** Translate a normalized match back to its complete original glyph span. */
export function originalTextRange(
	normalized: NormalizedText,
	start: number,
	end: number,
) {
	for (let i = normalized.maps.length - 1; i >= 0; i--) {
		const map = normalized.maps[i]!;
		start = sourceOffset(map, start, false);
		end = sourceOffset(map, end - 1, true);
	}
	return { start, end };
}
