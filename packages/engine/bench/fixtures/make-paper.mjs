// Generates demo/public/paper.pdf: two-column paper for smart selection (tests import makePaper()).
// Usage: node bench/fixtures/make-paper.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require(process.env.PDF_LIB ?? "pdf-lib");

const W = 612;
const H = 792;
const M = 54;
const GUTTER = 18;
const COL = (W - 2 * M - GUTTER) / 2;
const SIZE = 9.5;
const LEAD = 11.5;

export const SECTIONS = [
	["h", "1 Introduction"],
	[
		"p",
		"Selecting text in a PDF should feel as precise as selecting it in a text editor. Smith et al. (2020) showed that readers highlight whole sentences far more often than single words, and that a selection which spills into the neighbouring column is the most common complaint. As shown in Fig. 2, the error rate grows with the number of columns, i.e., two-column papers fare worst. Earlier viewers snapped to lines, e.g. the triple click selected one visual line, which rarely matches what a reader means.",
	],
	[
		"p",
		"Reprogramming the selection model is therefore worthwhile. We measured a mean selection time of 3.5 seconds per highlight (s.d. 0.8) across 42 participants, and the difference between conditions was significant (p < 0.05). Participants with prior experience of reference managers were faster, as reported before.[12] Later work [13, 14] confirmed the effect for scanned documents (Jones and Lee, 2019). These observations motivate the interpretation-free approach described below, which relies only on the geometry of the characters on the page.",
	],
	["h", "2 Methods"],
	[
		"p",
		"Every page is first split into visual rows, then into columns by cutting along the widest vertical whitespace. Eq. (3) gives the gap threshold in units of the median glyph height. Paragraphs follow from line geometry: a larger gap, a first-line indentation, or a short line ending in punctuation starts a new one. Headers and footers are rows in the outer tenth of the page that are separated from the body by a clear gap.",
	],
	[
		"p",
		"Sentences are segmented with the Unicode rules and then repaired for scholarly prose. Abbreviations such as Fig. and Eq. never end a sentence, nor do initials like J. R. Tolkien or a citation that follows a full stop. Decimal numbers such as 0.25 or 12.5 are left intact. A sentence may run over several lines and over a page break within the same flow of text, but it never jumps from one column into the other, because readers do not perceive those as one sentence even when the underlying content stream happens to continue there without any visible interruption whatsoever.",
	],
	[
		"p",
		"Words are segmented with the Unicode word rules, which also handle Chinese and Japanese text through dictionaries. A word hyphenated at the end of a line is joined with its second half on the next line, so a double click on either half selects the whole word. Ligatures count as letters and never split a word. The implementation keeps all of this work away from the frame loop: the structure of a page is computed once, on the first multi-click, and cached until the page is unloaded from memory again. Because segmentation runs on demand, a page that is only scrolled past never pays for it, and a page that is selected repeatedly pays only once for the whole session of reading and annotating its text.",
	],
	["h", "3 Results"],
	[
		"p",
		"Across all documents the snapping matched the intended unit in 97.2 percent of the trials. The remaining errors came from tables and from captions that were typeset inside a column without any vertical gap. Two-column papers no longer produced selections that crossed the gutter, and headers or footers were never included in a paragraph selection. Scanned documents with an OCR text layer behaved like born-digital ones, provided the recognised words were positioned on the page with reasonable accuracy and the reading order of the text layer followed the visual columns.",
	],
	[
		"p",
		"Interestingly, the long-press gesture on touch devices benefited most. Selecting a word and then dragging the handles by word made highlights cleaner, and participants rarely had to correct the ends of a selection afterwards. We expect similar gains for annotation workflows in general and for collaborative reading in particular, where an imprecise highlight is copied by every co-reader of the document.",
	],
	["fig", "Figure 1: Selection accuracy across 42 papers. Error bars show the standard deviation over participants."],
	["h", "4 Discussion"],
	[
		"p",
		"Geometry alone cannot resolve every layout. Multi-column magazines with irregular boxes, marginal notes and pull quotes need more than an XY cut, and right-to-left scripts need their own paragraph rules. Nevertheless, a simple model that respects columns and running heads removes the most frequent mistakes at negligible cost, which makes it a sensible default for any viewer that renders its own text selection.",
	],
	[
		"p",
		"Several questions remain open. The first concerns documents whose content stream follows neither the visual columns nor the reading order, which happens with some typesetting systems that emit text in the order it was edited. A second concerns footnotes, which sit at the bottom of a column and are visually separated from the body by a short rule rather than by a gap. A third concerns equations set on their own line, which split a paragraph visually although they belong to the sentence around them and should be selected with it whenever a reader asks for the whole sentence.",
	],
	[
		"p",
		"We also observed that readers rarely select more than a paragraph at once, and that they almost never extend a selection across a page break on purpose. When they do, it is usually to capture a sentence that the page break happens to interrupt, so the viewer should follow the sentence onto the next page and stop there instead of selecting everything in between, including the running header and the page number that the eye skips without noticing them at all while reading the continuous argument of the text.",
	],
	["h", "5 Conclusion"],
	[
		"p",
		"Snapping selections to linguistic units is a small feature with a large effect on perceived quality. With columns, running heads and paragraph geometry taken into account, multi-click selection in a PDF finally behaves the way readers expect from every other text surface they use.",
	],
];

/** Greedy line breaking with hyphenation at any point leaving 3+ letters on each side. */
function breakLines(text, font, size, width, indent) {
	const words = text.split(/\s+/);
	const space = font.widthOfTextAtSize(" ", size);
	const lines = [];
	let line = [];
	let used = indent;
	const fits = (w) => used + (line.length ? space : 0) + w <= width;
	for (let k = 0; k < words.length; k++) {
		const word = words[k];
		const w = font.widthOfTextAtSize(word, size);
		if (fits(w) || !line.length) {
			used += (line.length ? space : 0) + w;
			line.push(word);
			continue;
		}
		let split = -1;
		if (/^[A-Za-z]{7,}[,.]?$/.test(word))
			for (let i = word.replace(/[,.]$/, "").length - 3; i >= 3; i--)
				if (fits(font.widthOfTextAtSize(`${word.slice(0, i)}-`, size))) {
					split = i;
					break;
				}
		if (split > 0) {
			line.push(`${word.slice(0, split)}-`);
			words.splice(k + 1, 0, word.slice(split));
		} else k--;
		lines.push(line);
		line = [];
		used = 0;
	}
	if (line.length) lines.push(line);
	return lines;
}

export async function makePaper() {
	const doc = await PDFDocument.create();
	doc.setTitle("Smart selection fixture");
	const times = await doc.embedFont(StandardFonts.TimesRoman);
	const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
	const helv = await doc.embedFont(StandardFonts.Helvetica);
	const pages = [];
	const newPage = () => {
		const page = doc.addPage([W, H]);
		const n = pages.push(page);
		page.drawText("Journal of Fixture Studies 12 (2026)", { x: M, y: H - 34, size: 8, font: helv });
		const right = `Research article · page ${n}`;
		page.drawText(right, { x: W - M - helv.widthOfTextAtSize(right, 8), y: H - 34, size: 8, font: helv });
		const num = String(n);
		page.drawText(num, { x: W / 2 - helv.widthOfTextAtSize(num, 9) / 2, y: 30, size: 9, font: helv });
		return page;
	};
	let page = newPage();
	const center = (text, y, size, font) => page.drawText(text, { x: W / 2 - font.widthOfTextAtSize(text, size) / 2, y, size, font });
	center("Precise Text Selection for Two-Column Documents", H - 84, 16, bold);
	center("A. Author and B. Writer", H - 104, 10, times);
	let y = H - 132;
	page.drawText("Abstract", { x: M, y, size: 9.5, font: bold });
	y -= 12;
	const abstract =
		"We describe how a PDF viewer can snap selections to words, sentences and paragraphs while respecting the columns of the page. The method needs nothing but character boxes and runs in a few milliseconds per page.";
	for (const [i, words] of breakLines(abstract, times, 9, W - 2 * M, 0).entries()) {
		page.drawText(words.join(" "), { x: M, y, size: 9, font: times });
		y -= 11;
		if (i > 4) break;
	}
	const top = y - 14;
	let col = 0;
	y = top;
	const bottom = 64;
	const advance = (dy) => {
		if (y - dy >= bottom) return;
		if (col === 0) {
			col = 1;
			y = page === pages[0] ? top : H - 60;
		} else {
			page = newPage();
			col = 0;
			y = H - 60;
		}
	};
	const x0 = () => M + col * (COL + GUTTER);
	let afterHeading = true;
	for (const [kind, text] of SECTIONS) {
		if (kind === "h") {
			advance(LEAD * 3);
			y -= 6;
			page.drawText(text, { x: x0(), y, size: 10.5, font: bold });
			y -= LEAD + 2;
			afterHeading = true;
			continue;
		}
		if (kind === "fig") {
			advance(110);
			page.drawRectangle({ x: x0() + 20, y: y - 70, width: COL - 40, height: 66, color: rgb(0.85, 0.85, 0.9) });
			y -= 84;
			for (const words of breakLines(text, times, 8, COL, 0)) {
				page.drawText(words.join(" "), { x: x0(), y, size: 8, font: times });
				y -= 10;
			}
			y -= 6;
			continue;
		}
		const indent = afterHeading ? 0 : 12;
		afterHeading = false;
		const lines = breakLines(text, times, SIZE, COL, indent);
		for (const [i, words] of lines.entries()) {
			advance(LEAD);
			const x = x0() + (i === 0 ? indent : 0);
			const width = COL - (i === 0 ? indent : 0);
			const natural = words.reduce((s, w) => s + times.widthOfTextAtSize(w, SIZE), 0);
			const last = i === lines.length - 1;
			const gap = last || words.length < 2 ? times.widthOfTextAtSize(" ", SIZE) : (width - natural) / (words.length - 1);
			let cx = x;
			for (const word of words) {
				page.drawText(word, { x: cx, y, size: SIZE, font: times });
				cx += times.widthOfTextAtSize(word, SIZE) + gap;
			}
			y -= LEAD;
		}
	}
	return doc.save();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const bytes = await makePaper();
	writeFileSync(new URL("../../demo/public/paper.pdf", import.meta.url), bytes);
	console.log(`paper.pdf: ${bytes.length} bytes`);
}
