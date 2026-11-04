// Generates demo/public/scan-ocr.pdf: two-column scan with a per-word invisible OCR layer (tests import makeScanOcr()).
// Usage: node bench/fixtures/make-scan-ocr.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { encodePng } from "./png.mjs";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, beginText, endText, setFontAndSize, setTextMatrix, setCharacterSqueeze, setTextRenderingMode, showText, TextRenderingMode } =
	require(process.env.PDF_LIB ?? "pdf-lib");

const W = 612;
const H = 792;
const M = 60;
const GUTTER = 24;
const COL = (W - 2 * M - GUTTER) / 2;
const SIZE = 10;
const LEAD = 13;

export const OCR_TEXT = [
	"The committee met on the third of May to review the survey of the northern district. Dr. Hale reported that the old mill, i.e. the building on the river, was in poor repair. The estimate for the roof was 4.5 thousand pounds, approx. twice the figure of the previous year.",
	"Members asked whether the work could be divided into stages. Mr. Grant proposed that the first stage cover the roof and the drainage only, and that the remaining repairs wait for the spring. The proposal was carried without objection after a short discussion of the accounts.",
	"The secretary then read a letter from the county archivist concerning the parish records. The archivist offered to photograph the registers free of charge, provided the originals were deposited with the county for safekeeping during the work.",
	"After some debate the committee agreed to accept the offer. It was noted that the registers had suffered water damage in the flood of the previous winter, and that their condition would only worsen if nothing were done to preserve them for future readers.",
];

function rand(seed) {
	let s = seed;
	return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

export async function makeScanOcr() {
	const doc = await PDFDocument.create();
	doc.setTitle("OCR scan fixture");
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const r = rand(11);
	/** words as scanned: text and box in page points (top-left origin) */
	const words = [];
	const place = (text, x, y, size, width) => words.push({ text, x, y, size, width });
	const line = (text, x, y, size) => {
		let cx = x;
		for (const w of text.split(" ")) {
			const width = font.widthOfTextAtSize(w, size) * (0.92 + r() * 0.16);
			place(w, cx, y + (r() - 0.5) * 1.2, size, width);
			cx += width + size * (0.3 + r() * 0.15);
		}
	};
	line("Proceedings of the Fixture Society 1987", M, 40, 8);
	line("Minutes of the spring meeting", M, 76, 13);
	let col = 0;
	let y = 110;
	const scanned = (t) => ({ t, width: font.widthOfTextAtSize(t, SIZE) * (0.92 + r() * 0.16), space: SIZE * (0.3 + r() * 0.1) });
	for (const [p, para] of OCR_TEXT.entries()) {
		const tokens = para.split(" ").map(scanned);
		let first = true;
		while (tokens.length) {
			const indent = first ? 14 : 0;
			let cx = M + col * (COL + GUTTER) + indent;
			const end = M + col * (COL + GUTTER) + COL;
			const row = [];
			while (tokens.length && cx + tokens[0].width <= end) {
				const w = tokens.shift();
				row.push([w, cx]);
				cx += w.width + w.space;
			}
			// hyphenate a long word that does not fit
			const next = tokens[0];
			if (next && next.t.length >= 8 && /^[a-z]+$/.test(next.t)) {
				const cut = Math.ceil(next.t.length / 2);
				const head = scanned(`${next.t.slice(0, cut)}-`);
				if (cx + head.width <= end) {
					tokens[0] = scanned(next.t.slice(cut));
					row.push([head, cx]);
				}
			}
			for (const [w, x] of row) place(w.t, x, y + (r() - 0.5) * 1.2, SIZE, w.width);
			y += LEAD;
			first = false;
			if (y > H - 90 && col === 0) {
				col = 1;
				y = 110;
			}
		}
		if (p === 1 && col === 0) {
			col = 1;
			y = 110;
		}
	}
	line("- 3 -", W / 2 - 10, H - 40, 9);

	// The scan: paper with ink where each word sits.
	const S = 2;
	const pw = W * S;
	const ph = H * S;
	const px = new Uint8Array(pw * ph * 3).fill(236);
	for (const w of words) {
		const x0 = Math.round(w.x * S);
		const x1 = Math.round((w.x + w.width) * S);
		const y0 = Math.round((w.y - w.size * 0.72) * S);
		const y1 = Math.round(w.y * S);
		for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx += 1) if ((xx >> 1) % 3) px.fill(50, (yy * pw + xx) * 3, (yy * pw + xx) * 3 + 3);
	}
	const page = doc.addPage([W, H]);
	page.drawImage(await doc.embedPng(encodePng(px, pw, ph)), { x: 0, y: 0, width: W, height: H });
	const key = page.node.newFontDictionary(font.name, font.ref);
	const ops = [beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
	for (const w of words) {
		const natural = font.widthOfTextAtSize(w.text, w.size);
		ops.push(setFontAndSize(key, w.size), setCharacterSqueeze((100 * w.width) / natural), setTextMatrix(1, 0, 0, 1, w.x, H - w.y), showText(font.encodeText(w.text)));
	}
	ops.push(endText());
	page.pushOperators(...ops);
	return doc.save();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const bytes = await makeScanOcr();
	writeFileSync(new URL("../../demo/public/scan-ocr.pdf", import.meta.url), bytes);
	console.log(`scan-ocr.pdf: ${bytes.length} bytes`);
}
