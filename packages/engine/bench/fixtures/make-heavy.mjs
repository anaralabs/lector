// Generates the slow-tile fixtures (gitignored):
//   demo/public/heavy-scan.pdf: N pages (default 120), each a unique 300dpi greyscale JPEG scan
//   demo/public/heavy-vector.pdf: M pages (default 30) of dense vector figures (~90k path segments each)
// Usage: node bench/fixtures/make-heavy.mjs [scanPages] [vectorPages]
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as mupdf from "mupdf";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode } = require(process.env.PDF_LIB ?? "pdf-lib");

const scanPages = Number(process.argv[2] ?? 120);
const vectorPages = Number(process.argv[3] ?? 30);
const W = 612;
const H = 792;
const out = (name) => new URL(`../../demo/public/${name}`, import.meta.url);

function scanJpeg(page) {
	const w = 2550;
	const h = 3300;
	const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, w, h], false);
	const px = pix.getPixels();
	let seed = 1000 + page * 7919;
	const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	for (let i = 0; i < w * h; i++) px[i] = 232 + ((rand() * 14) | 0);
	const ink = (x0, y0, x1, y1) => {
		for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[y * w + x] = 30 + ((rand() * 40) | 0);
	};
	for (let line = 0; line < 46; line++) {
		const y = 260 + line * 62 + ((rand() * 6) | 0);
		let x = 230 + ((rand() * 20) | 0);
		while (x < w - 260) {
			const word = 40 + Math.floor(rand() * 160);
			for (let c = 0; c + 18 < word; c += 22) ink(x + c, y, x + c + 16, y + 30 + ((rand() * 8) | 0));
			x += word + 28;
		}
	}
	const jpeg = pix.asJPEG(70, false);
	pix.destroy();
	return jpeg;
}

async function makeScan() {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (let p = 0; p < scanPages; p++) {
		const page = doc.addPage([W, H]);
		const img = await doc.embedJpg(scanJpeg(p));
		page.drawImage(img, { x: 0, y: 0, width: W, height: H });
		// invisible OCR layer, like a real scan
		page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
		page.drawText(`Scanned page ${p + 1} of the heavy fixture`, { x: 56, y: H - 72, size: 12, font, color: rgb(0, 0, 0) });
		page.pushOperators(popGraphicsState());
	}
	const bytes = await doc.save();
	writeFileSync(out("heavy-scan.pdf"), bytes);
	console.log(`heavy-scan.pdf: ${scanPages} pages, ${(bytes.length / 1048576).toFixed(1)} MB`);
}

async function makeVector() {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (let p = 0; p < vectorPages; p++) {
		const page = doc.addPage([W, H]);
		let seed = 77 + p * 104729;
		const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
		const ops = [];
		for (let i = 0; i < 3000; i++) {
			ops.push(`${rand().toFixed(3)} ${rand().toFixed(3)} ${rand().toFixed(3)} RG 0.4 w`);
			let x = 40 + rand() * (W - 80);
			let y = 60 + rand() * (H - 160);
			ops.push(`${x.toFixed(2)} ${y.toFixed(2)} m`);
			for (let s = 0; s < 30; s++) {
				x = Math.min(W - 40, Math.max(40, x + (rand() - 0.5) * 14));
				y = Math.min(H - 100, Math.max(60, y + (rand() - 0.5) * 14));
				ops.push(`${x.toFixed(2)} ${y.toFixed(2)} l`);
			}
			ops.push("S");
		}
		for (let i = 0; i < 5000; i++) {
			ops.push(`${rand().toFixed(3)} 0.3 ${rand().toFixed(3)} rg ${(40 + rand() * (W - 80)).toFixed(2)} ${(60 + rand() * (H - 160)).toFixed(2)} 1.6 1.6 re f`);
		}
		const stream = doc.context.flateStream(ops.join("\n"));
		const ref = doc.context.register(stream);
		page.node.addContentStream(ref);
		page.drawText(`Figure ${p + 1}: dense vector plot`, { x: 56, y: H - 60, size: 14, font, color: rgb(0, 0, 0) });
	}
	const bytes = await doc.save();
	writeFileSync(out("heavy-vector.pdf"), bytes);
	console.log(`heavy-vector.pdf: ${vectorPages} pages, ${(bytes.length / 1048576).toFixed(1)} MB`);
}

await makeScan();
await makeVector();
