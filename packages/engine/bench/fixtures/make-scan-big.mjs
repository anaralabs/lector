// Generates demo/public/scan-big.pdf: a large scanned book for range-loading
// benches. Each page is one full-page grey "scan" (paper noise + ink lines)
// with a different page-number pattern, written without object streams so page
// dictionaries sit next to their images, as scanner output usually does.
// Usage: node bench/fixtures/make-scan-big.mjs [pages=320] [px=1240]
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { encodePng } from "./png.mjs";

const require = createRequire(import.meta.url);
const { PDFDocument } = require(process.env.PDF_LIB ?? "pdf-lib");
const pages = Number(process.argv[2] ?? 320);
const W = Number(process.argv[3] ?? 1240);
const H = Math.round((W * 11) / 8.5);

function scan(page) {
	const px = new Uint8Array(W * H * 3);
	let seed = page * 7919 + 1;
	const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	for (let i = 0; i < W * H; i++) {
		const v = 240 - (rand() < 0.07 ? Math.floor(rand() * 10) : 0);
		px[i * 3] = v;
		px[i * 3 + 1] = v - 2;
		px[i * 3 + 2] = v - 6;
	}
	const ink = (x0, y0, x1, y1) => {
		for (let y = y0; y < Math.min(H, y1); y++)
			for (let x = x0; x < Math.min(W, x1); x++) {
				const i = (y * W + x) * 3;
				px[i] = px[i + 1] = px[i + 2] = 40;
			}
	};
	const s = W / 612;
	for (let line = 0; line < 38; line++) {
		const y = Math.round((70 + line * 17) * s);
		let x = Math.round(60 * s);
		while (x < W - 70 * s) {
			const word = Math.round((10 + rand() * 40) * s);
			for (let c = 0; c < word; c += Math.round(6 * s)) ink(x + c, y, x + c + Math.round(4 * s), y + Math.round(9 * s));
			x += word + Math.round(8 * s);
		}
	}
	// Page number as a bar code-ish strip, so pages differ visibly in screenshots.
	for (let b = 0; b < 10; b++) if ((page >> b) & 1) ink(Math.round((260 + b * 9) * s), Math.round(760 * s), Math.round((266 + b * 9) * s), Math.round(775 * s));
	return px;
}

const doc = await PDFDocument.create();
doc.setTitle("Scanned book");
for (let p = 0; p < pages; p++) {
	const image = await doc.embedPng(encodePng(scan(p), W, H));
	const page = doc.addPage([612, 792]);
	page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
}
const bytes = await doc.save({ useObjectStreams: false });
const out = new URL(`../../demo/public/${process.env.OUT ?? "scan-big.pdf"}`, import.meta.url);
writeFileSync(out, bytes);
console.log(`${out.pathname}: ${pages} pages, ${(bytes.length / 1048576).toFixed(1)} MB`);
