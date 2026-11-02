// Generates demo/public/links.pdf: a contents page linking to 14 distinct pages
// (more than a raster worker's page cache holds) plus a URL link and a photo,
// so link and image extraction must keep the contents page loaded while link
// destinations load theirs. The last page is twice as tall (fit-page jumps).
// Usage: node bench/fixtures/make-links.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { encodePng } from "./png.mjs";

const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFString, StandardFonts } = require(process.env.PDF_LIB ?? "pdf-lib");

const W = 612;
const H = 792;
const TARGETS = 14;

const photo = new Uint8Array(160 * 120 * 3);
for (let i = 0; i < 160 * 120; i++) {
	photo[i * 3] = (i * 3) & 0xff;
	photo[i * 3 + 1] = 80;
	photo[i * 3 + 2] = 200;
}

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const image = await doc.embedPng(encodePng(photo, 160, 120));
const contents = doc.addPage([W, H]);
contents.drawText("Contents", { x: 72, y: H - 72, size: 24, font });
const pages = [];
for (let i = 1; i <= TARGETS; i++) {
	const tall = i === TARGETS;
	const p = doc.addPage([W, tall ? 1600 : H]);
	p.drawText(`Chapter ${i}`, { x: 72, y: (tall ? 1600 : H) - 100, size: 24, font });
	pages.push(p);
}
const annots = [];
pages.forEach((p, k) => {
	const y = H - 120 - k * 22;
	contents.drawText(`Chapter ${k + 1}`, { x: 72, y, size: 14, font });
	annots.push(
		doc.context.register(
			doc.context.obj({
				Type: "Annot",
				Subtype: "Link",
				Rect: [70, y - 4, 200, y + 14],
				Border: [0, 0, 0],
				Dest: [p.ref, PDFName.of("XYZ"), null, p.getHeight() - 90, null],
			}),
		),
	);
});
const uy = H - 120 - TARGETS * 22;
contents.drawText("https://example.com/", { x: 72, y: uy, size: 14, font });
annots.push(
	doc.context.register(
		doc.context.obj({
			Type: "Annot",
			Subtype: "Link",
			Rect: [70, uy - 4, 240, uy + 14],
			Border: [0, 0, 0],
			A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com/") },
		}),
	),
);
contents.node.set(PDFName.of("Annots"), doc.context.obj(annots));
contents.drawImage(image, { x: 380, y: 80, width: 160, height: 120 });

const bytes = await doc.save();
writeFileSync(new URL("../../demo/public/links.pdf", import.meta.url), bytes);
console.log(`links.pdf: ${bytes.length} bytes`);
