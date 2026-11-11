// Smart selection units on real PDFium text: generated paper, OCR'd scan, published two-column article.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

// src/text.ts imports without extensions (bundler style); resolve them for Node.
register(
	`data:text/javascript,${encodeURIComponent(
		"export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) { if (s.startsWith('.') && !s.endsWith('.ts')) return n(s + '.ts', c); throw e; } }",
	)}`,
);
const { PageText } = await import("../src/text.ts");
// @ts-expect-error plain .mjs scripts, no types
const { makePaper } = await import("../bench/fixtures/make-paper.mjs");
// @ts-expect-error plain .mjs scripts, no types
const { makeScanOcr } = await import("../bench/fixtures/make-scan-ocr.mjs");
// @ts-expect-error plain .mjs scripts, no types
const { extractText } = await import("./fixtures/pdfium-text.mjs");

type Text = InstanceType<typeof PageText>;
interface Extracted {
	h: number;
	codes: Uint32Array;
	boxes: Float32Array;
}

const pages = (list: Extracted[]) => list.map((p) => new PageText(p.codes, p.boxes, p.h));
const paper = pages(await extractText(await makePaper()));
const [scan] = pages(await extractText(await makeScanOcr()));
const article = pages(
	JSON.parse(readFileSync(new URL("fixtures/yucel-2024.json", import.meta.url), "utf8")).pages.map((p: { h: number; text: string; boxes: string }) => {
		const q = new Int16Array(new Uint8Array(Buffer.from(p.boxes, "base64")).buffer);
		return { h: p.h, codes: Uint32Array.from([...p.text], (c) => c.codePointAt(0)!), boxes: Float32Array.from(q, (v) => v / 10) };
	}),
);

/** char index of `needle` (+ offset) in the page text */
const at = (t: Text, needle: string, offset = 0) => {
	const { text, chars } = t.textWithMap();
	const i = text.replace(/\n/g, " ").indexOf(needle);
	assert.ok(i >= 0, `"${needle}" not on the page`);
	return chars[i + offset]!;
};
const flat = (t: Text, [a, z]: readonly [number, number]) => t.text(a, z, { lineBreaks: "space", ignoreHyphenation: true });
const word = (t: Text, needle: string, offset = 0) => flat(t, t.wordAt(at(t, needle, offset)));
const sentence = (t: Text, needle: string) => {
	const s = t.layout().sentence(at(t, needle));
	return flat(t, [s.start, s.end]);
};
const paragraph = (t: Text, needle: string) => flat(t, t.layout().paragraph(at(t, needle)));

/** synthetic page: one text line per entry, monospaced 6pt boxes, 12pt apart */
const synth = (lines: string[]) => {
	const codes: number[] = [];
	const boxes: number[] = [];
	for (const [n, line] of lines.entries()) {
		if (n) {
			codes.push(13, 10);
			boxes.push(0, 0, 0, 0, 0, 0, 0, 0);
		}
		[...line].forEach((ch, i) => {
			codes.push(ch.codePointAt(0)!);
			boxes.push(...(ch === " " ? [0, 0, 0, 0] : [50 + i * 6, 100 + n * 12, 56 + i * 6, 110 + n * 12]));
		});
	}
	return new PageText(Uint32Array.from(codes), Float32Array.from(boxes));
};

test("paper: columns, running header and footer", () => {
	const [p1, p2] = paper as [Text, Text];
	const body = (t: Text) => t.layout().columns.filter((c) => !c.margin);
	const left = p1.layout().columnAt(at(p1, "Because segmentation"));
	const right = p1.layout().columnAt(at(p1, "selected repeatedly"));
	assert.notEqual(left, right);
	assert.ok(body(p1).length >= 3, "title block plus two columns");
	assert.equal(p1.layout().columnAt(at(p1, "Smith et al.")), left);
	for (const t of [p1, p2]) assert.ok(t.layout().isMargin(at(t, "Journal of Fixture Studies")));
	assert.ok(!p1.layout().isMargin(at(p1, "Selecting")));
	assert.ok(!p2.layout().isMargin(at(p2, "Snapping")));
	const pageNumber = p1.lines.findIndex((l: { start: number; end: number }) => p1.text(l.start, l.end).trim() === "1");
	assert.ok(p1.layout().isMarginLine(pageNumber), "page number");
});

test("paper: double click selects the word, joined across a hyphenated line break", () => {
	const [p1] = paper as [Text];
	assert.equal(word(p1, "Smith"), "Smith");
	assert.equal(word(p1, "Smith", 4), "Smith");
	// "rea-⏎ding" at the end of a line in the right column
	assert.equal(word(p1, "ding and annotating"), "reading");
	assert.equal(word(p1, "session of rea", 12), "reading");
	assert.equal(word(p1, "3.5 seconds"), "3.5");
	assert.equal(word(p1, "Two-Column"), "Two");
});

test("paper: triple click selects the sentence, through abbreviations, citations and decimals", () => {
	const [p1] = paper as [Text];
	assert.equal(
		sentence(p1, "highlight whole"),
		"Smith et al. (2020) showed that readers highlight whole sentences far more often than single words, and that a selection which spills into the neighbouring column is the most common complaint.",
	);
	assert.equal(sentence(p1, "error rate"), "As shown in Fig. 2, the error rate grows with the number of columns, i.e., two-column papers fare worst.");
	assert.equal(sentence(p1, "snapped to lines"), "Earlier viewers snapped to lines, e.g. the triple click selected one visual line, which rarely matches what a reader means.");
	assert.equal(
		sentence(p1, "mean selection time"),
		"We measured a mean selection time of 3.5 seconds per highlight (s.d. 0.8) across 42 participants, and the difference between conditions was significant (p < 0.05).",
	);
	assert.equal(sentence(p1, "reference managers"), "Participants with prior experience of reference managers were faster, as reported before.[12]");
	assert.equal(sentence(p1, "Later work"), "Later work [13, 14] confirmed the effect for scanned documents (Jones and Lee, 2019).");
	assert.equal(sentence(p1, "gap threshold"), "Eq. (3) gives the gap threshold in units of the median glyph height.");
	assert.equal(
		sentence(p1, "Tolkien"),
		"Abbreviations such as Fig. and Eq. never end a sentence, nor do initials like J. R. Tolkien or a citation that follows a full stop.",
	);
	assert.equal(sentence(p1, "0.25"), "Decimal numbers such as 0.25 or 12.5 are left intact.");
	assert.equal(sentence(p1, "B. Writer"), "A. Author and B. Writer");
});

test("paper: a sentence stops at the column break, and continues over the page break", () => {
	const [p1, p2] = paper as [Text, Text];
	const tail = p1.layout().sentence(at(p1, "Because segmentation"));
	assert.equal(flat(p1, [tail.start, tail.end]), "Because segmentation runs on demand, a page that is only scrolled past never pays for it, and a page that is");
	assert.equal(tail.openEnd, false, "the column break is not a page break");
	assert.equal(sentence(p1, "selected repeatedly"), "selected repeatedly pays only once for the whole session of reading and annotating its text.");
	const last = p1.layout().edgeSentence("last")!;
	const first = p2.layout().edgeSentence("first")!;
	assert.ok(last.openEnd && first.openStart);
	const joined = `${flat(p1, [last.start, last.end])} ${flat(p2, [first.start, first.end])}`;
	assert.match(joined, /^A third concerns equations .* whole sentence\.$/);
	assert.equal(p2.layout().edgeSentence("last")!.openEnd, false);
});

test("paper: four clicks select the paragraph from line geometry", () => {
	const [p1] = paper as [Text];
	const methods = paragraph(p1, "gap threshold");
	assert.match(methods, /^Every page is first split .* by a clear gap\.$/);
	assert.equal(paragraph(p1, "2 Methods"), "2 Methods");
	assert.equal(paragraph(p1, "Error bars"), "Figure 1: Selection accuracy across 42 papers. Error bars show the standard deviation over participants.");
	assert.match(paragraph(p1, "Reprogramming the"), /^Reprogramming the selection model .* geometry of the characters on the page\.$/);
	assert.equal(paragraph(p1, "Abstract"), "Abstract");
	// the paragraph at a column break ends at the column
	assert.match(paragraph(p1, "Because segmentation"), /^Words are segmented .* and a page that is$/);
	for (const [a, z] of p1.layout().paragraphs()) {
		const text = flat(p1, [a, z]);
		if (!p1.layout().isMargin(a)) assert.doesNotMatch(text, /Journal of Fixture Studies/);
	}
});

test("paper: a unit drag stays in its column until the pointer is clearly in the other one", () => {
	const [p1] = paper as [Text];
	const L = p1.layout();
	const anchor = at(p1, "Because segmentation");
	const col = L.columnAt(anchor);
	const left = p1.rects(anchor, anchor + 5)[0]!;
	const right = p1.rects(at(p1, "selected repeatedly"), at(p1, "selected repeatedly") + 5)[0]!;
	const y = left.y + left.h / 2;
	// a caret at the end of the left column is also the right column's start: test the char before it
	const colOf = (caret: number) => L.columnAt(Math.max(0, caret - 1));
	// in the gutter, level with the anchor line
	assert.equal(colOf(p1.flowHit(306, y, col)), col);
	// in the gutter right next to the other column's text: still left
	assert.equal(colOf(p1.flowHit(right.x - 4, y, col)), col);
	// a plain drag (no anchor column) picks whatever line is nearest
	assert.notEqual(colOf(p1.flowHit(right.x - 4, y, -1)), col);
	// on the right column's text
	assert.equal(L.columnAt(p1.flowHit(right.x + 20, right.y + right.h / 2, col)), L.columnAt(at(p1, "selected repeatedly")));
	// between the running header and the body: the body, not the header
	assert.ok(!L.isMargin(p1.flowHit(300, 50, -1)));
	assert.ok(L.isMargin(p1.flowHit(100, 31, -1)), "right on the header");
	// below the page's last body line: the footer is not picked up
	assert.ok(!L.isMargin(p1.flowHit(300, 740, col)));
});

test("scan: the OCR layer gets columns, words, sentences and paragraphs", () => {
	const t = scan as Text;
	const L = t.layout();
	assert.equal(L.columns.filter((c) => !c.margin).length, 2);
	assert.ok(L.isMargin(at(t, "Proceedings")));
	assert.ok(L.isMargin(at(t, "- 3 -")));
	assert.notEqual(L.columnAt(at(t, "The committee")), L.columnAt(at(t, "The secretary")));
	assert.equal(word(t, "osal was carried"), "proposal");
	assert.equal(word(t, "northern"), "northern");
	assert.equal(sentence(t, "old mill"), "Dr. Hale reported that the old mill, i.e. the building on the river, was in poor repair.");
	assert.equal(sentence(t, "estimate"), "The estimate for the roof was 4.5 thousand pounds, approx. twice the figure of the previous year.");
	assert.equal(sentence(t, "osal was carried"), "The proposal was carried without objection after a short discussion of the accounts.");
	assert.match(paragraph(t, "Mr. Grant"), /^Members asked whether .* discussion of the accounts\.$/);
	assert.match(paragraph(t, "free of charge"), /^The secretary then read .* during the work\.$/);
	assert.equal(paragraph(t, "Minutes"), "Minutes of the spring meeting");
});

test("article: real two-column layout, hyphenation and scientific prose", () => {
	const [a, b] = article as [Text, Text];
	for (const t of [a, b]) {
		assert.equal(t.layout().columns.filter((c) => !c.margin).length, 2);
		assert.ok(t.layout().isMargin(at(t, "Nature Communications")));
		assert.ok(t.layout().isMargin(at(t, "Perspective")));
	}
	assert.equal(word(a, "approa"), "approaches");
	assert.equal(word(a, "ches that"), "approaches");
	assert.equal(sentence(a, "two-chemical"), "A two-chemical reprogramming procedure has shown to increase the C. elegans lifespan by 42.1%, and also to reduce DNA damage, ameliorate epigenetic age-related marks such as H3K9me3 and H3K27me3, partially prevent senescence and decrease oxidative stress20.");
	assert.equal(sentence(a, "c-Myc"), "c-Myc was excluded from the cocktail to reduce the risk of teratoma formation.");
	assert.equal(sentence(a, "skin regeneration"), "Moreover, this treatment increased skin regeneration capacity in mice15.");
	assert.match(paragraph(a, "cocktail from Stage"), /^Partial chemical reprogramming of mouse fibroblasts .* in vivo 7c treatment26\.$/);
	assert.equal(paragraph(a, "Therapeutic potential"), "Therapeutic potential of partial reprogramming");
	// col 1 ends mid-sentence; col 2 picks it up: neither side reaches into the other
	const end = b.layout().sentence(at(b, "version of the organism") - 3);
	assert.doesNotMatch(flat(b, [end.start, end.end]), /version of the organism/);
	assert.match(sentence(b, "version of the organism"), /^version of the organism, even though/);
	assert.equal(a.layout().sentence(0).openStart, true, "page starts mid-sentence");
});

test("words: ligatures, CJK and punctuation", () => {
	const t = synth(["an eﬃcient method", "我们研究了文本选择。", "(see Table 2)"]);
	assert.equal(word(t, "ﬃ"), "eﬃcient");
	const [a, z] = t.wordAt(at(t, "研"));
	assert.ok(z - a >= 1 && z - a < 6, "a CJK word, not the whole line");
	assert.equal(word(t, "("), "(");
	assert.equal(word(t, "see"), "see");
	// caret just after a word (its right half was clicked) still selects it
	assert.equal(flat(t, t.wordAt(at(t, "method") + 6)), "method");
});

test("sentences: segmenter repairs", () => {
	const t = synth(["Results are in Fig. 3 and Eq. 2. A new one starts. Smith et al. agree.", "As shown before. [4] The next one; see e.g. Smith (2001)."]);
	assert.equal(sentence(t, "Results"), "Results are in Fig. 3 and Eq. 2.");
	assert.equal(sentence(t, "new one"), "A new one starts.");
	assert.equal(sentence(t, "Smith et"), "Smith et al. agree.");
	assert.equal(sentence(t, "shown before"), "As shown before. [4]");
	assert.equal(sentence(t, "next one"), "The next one; see e.g. Smith (2001).");
});

test("hitTest: a click on a row lands on that row when the line above has a tall glyph over it", () => {
	const rows = ["Let f = \u222b g ds", "then the next row"];
	const codes: number[] = [];
	const boxes: number[] = [];
	for (const [n, row] of rows.entries()) {
		if (n) {
			codes.push(13, 10);
			boxes.push(0, 0, 0, 0, 0, 0, 0, 0);
		}
		[...row].forEach((ch, i) => {
			codes.push(ch.codePointAt(0)!);
			const tall = ch === "\u222b";
			boxes.push(...(ch === " " ? [0, 0, 0, 0] : [50 + i * 6, tall ? 88 : 100 + n * 12, 56 + i * 6, tall ? 124 : 110 + n * 12]));
		});
	}
	const t = new PageText(Uint32Array.from(codes), Float32Array.from(boxes));
	assert.equal(t.lines.length, 2);
	const second = rows[0]!.length + 2;
	// every glyph of the second row sits inside the first line's band
	for (let i = 0; i < rows[1]!.length; i++) {
		if (rows[1]![i] === " ") continue;
		const caret = t.hitTest(53 + i * 6, 117);
		assert.ok(caret === second + i || caret === second + i + 1, `row 2 char ${i} -> ${caret}`);
	}
	// and the first row is still reachable
	assert.ok(t.hitTest(53, 105) <= 1);
});
