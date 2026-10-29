// Generates demo/public/scan.pdf: dark-mode scan detection fixture.
//   p1: a full-page near-white "scan" image with dark text pixels + invisible OCR text
//   p2: vector text with a colourful photo in the middle (photo keeps its colours)
//   p3: a full-page colourful photo (covers the page but is not paper: stays original)
// Usage: PDF_LIB=/path/to/pdf-lib node bench/fixtures/make-scan.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { encodePng } from "./png.mjs";

const require = createRequire(import.meta.url);
const libPath = process.env.PDF_LIB ?? "/Users/giga/fun/anara-engine/node_modules/.pnpm/pdf-lib@1.17.1/node_modules/pdf-lib";
const { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode } = require(libPath);

const W = 612;
const H = 792;

// Scan: off-white paper with a little noise, dark "text lines" of glyph-ish blocks.
function scanPixels(w, h) {
	const px = new Uint8Array(w * h * 3);
	let seed = 7;
	const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	for (let i = 0; i < w * h; i++) {
		const v = 238 + (rand() < 0.01 ? 4 : 0);
		px[i * 3] = v;
		px[i * 3 + 1] = v - 2;
		px[i * 3 + 2] = v - 6; // slightly warm paper
	}
	const ink = (x0, y0, x1, y1) => {
		for (let y = y0; y < y1; y++)
			for (let x = x0; x < x1; x++) {
				const i = (y * w + x) * 3;
				px[i] = px[i + 1] = px[i + 2] = 40;
			}
	};
	for (let line = 0; line < 22; line++) {
		const y = 90 + line * 30;
		let x = 70;
		while (x < w - 90) {
			const word = 14 + Math.floor(rand() * 50);
			for (let c = 0; c < word; c += 7) ink(x + c, y, x + c + 5, y + 12);
			x += word + 10;
		}
	}
	return px;
}

// Photo: saturated colour field with soft shapes.
function photoPixels(w, h) {
	const px = new Uint8Array(w * h * 3);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 3;
			const u = x / w;
			const v = y / h;
			const d = Math.hypot(u - 0.6, v - 0.4);
			px[i] = Math.round(255 * (0.2 + 0.8 * u));
			px[i + 1] = Math.round(255 * (0.3 + 0.5 * Math.sin(v * 6) ** 2));
			px[i + 2] = Math.round(255 * Math.max(0, 1 - d * 2));
		}
	return px;
}

const doc = await PDFDocument.create();
doc.setTitle("Scan fixture");
const font = await doc.embedFont(StandardFonts.Helvetica);
const scan = await doc.embedPng(encodePng(scanPixels(612, 792), 612, 792));
const photo = await doc.embedPng(encodePng(photoPixels(320, 220), 320, 220));

const p1 = doc.addPage([W, H]);
p1.drawImage(scan, { x: 0, y: 0, width: W, height: H });
// Invisible OCR layer, like a searchable scan.
p1.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
p1.drawText("Scanned invoice: total amount due 42 euros", { x: 70, y: H - 102, size: 12, font });
p1.drawText("Payment within thirty days of receipt", { x: 70, y: H - 132, size: 12, font });
p1.pushOperators(popGraphicsState());

const p2 = doc.addPage([W, H]);
p2.drawText("Vector text above a photo", { x: 72, y: H - 90, size: 18, font, color: rgb(0, 0, 0) });
p2.drawImage(photo, { x: 146, y: 300, width: 320, height: 220 });
p2.drawText("Vector text below the photo", { x: 72, y: 250, size: 14, font, color: rgb(0, 0, 0) });

const p3 = doc.addPage([W, H]);
p3.drawImage(photo, { x: 0, y: 0, width: W, height: H });

const out = new URL("../../demo/public/scan.pdf", import.meta.url);
const bytes = await doc.save();
writeFileSync(out, bytes);
console.log(`wrote ${out.pathname} (${(bytes.length / 1024).toFixed(0)} KB)`);
