// Generates demo/public/annotations.pdf: annotations written the way Zotero,
// Acrobat and Preview write them (a two-column page, a comment thread, ink,
// free text, a hidden note, a rotated page), plus a note Anara's export wrote.
// Usage: node bench/fixtures/make-annotations.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PDFArray, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } = require(process.env.PDF_LIB ?? "pdf-lib");

export const W = 612;
export const H = 792;
const LINE = 14;
const COL = [[56, 290], [322, 556]];
const TOP = 700;

/** user-space rect [x0, y0, x1, y1] of line `i` (0 = top) in column `c`, `w` points wide */
export const lineRect = (c, i, w = COL[c][1] - COL[c][0]) => [COL[c][0], TOP - i * LINE - 3, COL[c][0] + w, TOP - i * LINE + 10];
/** Zotero/Acrobat/Preview quad order: top-left, top-right, bottom-left, bottom-right */
const quads = (rects) => rects.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]);
const union = (rects) => [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
const text = (s) => PDFHexString.fromText(s);

export const ZOTERO_RECTS = [lineRect(0, 30, 150), lineRect(0, 31), lineRect(1, 0, 120)];
export const ROTATED_RECT = [100, 400, 300, 412];

export async function annotated() {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.TimesRoman);
	const words = "Sleep after training consolidates declarative memory and participants recalled more word pairs the next day".split(" ");
	const fill = (page, cols) => {
		for (const c of cols)
			for (let i = 0; i < 44; i++) {
				const line = Array.from({ length: 7 }, (_, k) => words[(i * 7 + k + c * 3) % words.length]).join(" ");
				page.drawText(line, { x: COL[c][0], y: TOP - i * LINE, size: 10, font });
			}
	};
	const add = (page, dict) => {
		const ref = doc.context.register(doc.context.obj(dict));
		const key = PDFName.of("Annots");
		let annots = page.node.lookupMaybe(key, PDFArray);
		if (!annots) {
			annots = doc.context.obj([]);
			page.node.set(key, annots);
		}
		annots.push(ref);
		return ref;
	};
	const multiplyAp = (rect, rgb, rects) => {
		const path = rects.map(([x0, y0, x1, y1]) => `${x0} ${y0} m ${x1} ${y0} l ${x1} ${y1} l ${x0} ${y1} l h`).join("\n");
		const stream = doc.context.stream(`/G0 gs ${rgb.join(" ")} rg\n${path}\nf`, {
			Type: "XObject",
			Subtype: "Form",
			FormType: 1,
			BBox: rect,
			Resources: { ExtGState: { G0: { BM: "Multiply", CA: 1, ca: 1 } } },
		});
		return { N: doc.context.register(stream) };
	};

	// Zotero (pdf-worker's write.js): NM "Zotero-<key>", Zotero:Key, Multiply appearance, a popup for comments.
	const p0 = doc.addPage([W, H]);
	fill(p0, [0, 1]);
	const yellow = [1, 212 / 255, 0];
	const zRect = union(ZOTERO_RECTS);
	const zotero = add(p0, {
		Type: "Annot",
		Subtype: "Highlight",
		Rect: zRect,
		QuadPoints: quads(ZOTERO_RECTS),
		M: PDFString.of("D:20240311094512Z00'00'"),
		T: text("Ada Lovelace"),
		Contents: text("Key claim: sleep helps recall"),
		NM: PDFString.of("Zotero-ABCD1234"),
		"Zotero:Key": PDFString.of("ABCD1234"),
		F: 4,
		C: yellow,
		AP: multiplyAp(zRect, yellow, ZOTERO_RECTS),
	});
	add(p0, { Type: "Annot", Subtype: "Popup", Rect: [zRect[2], zRect[3] - 60, zRect[2] + 140, zRect[3]], Parent: zotero, Open: false, F: 28 });
	const uRects = [lineRect(1, 10, 200)];
	add(p0, {
		Type: "Annot",
		Subtype: "Underline",
		Rect: union(uRects),
		QuadPoints: quads(uRects),
		M: PDFString.of("D:20240311094800Z00'00'"),
		T: text("Ada Lovelace"),
		NM: PDFString.of("Zotero-EFGH5678"),
		F: 4,
		C: [0.37, 0.7, 0.2],
	});

	// Acrobat: UUID NM, Subj, CreationDate, a popup, and a reply thread (/IRT, /RT /R).
	const p1 = doc.addPage([W, H]);
	fill(p1, [0, 1]);
	const aRects = [lineRect(0, 4), lineRect(0, 5, 90)];
	const acrobat = add(p1, {
		Type: "Annot",
		Subtype: "Highlight",
		Rect: union(aRects),
		QuadPoints: quads(aRects),
		NM: PDFString.of("3f2a9c1e-7b44-4d0c-9a51-0c6e2b8d1f10"),
		T: text("Reviewer 1"),
		Subj: text("Highlight"),
		Contents: text("Is this effect size reported anywhere?"),
		M: PDFString.of("D:20231012143000+02'00'"),
		CreationDate: PDFString.of("D:20231012142900+02'00'"),
		F: 4,
		C: [0.329, 0.937, 1],
		CA: 0.6,
	});
	add(p1, { Type: "Annot", Subtype: "Popup", Rect: [460, 600, 600, 700], Parent: acrobat, Open: false, F: 28 });
	const reply = add(p1, {
		Type: "Annot",
		Subtype: "Text",
		Rect: [40, 640, 60, 660],
		IRT: acrobat,
		RT: PDFName.of("R"),
		NM: PDFString.of("7d1e0b2c-1111-4c3a-8f00-5b2d9e6a4c21"),
		T: text("Ada Lovelace"),
		Contents: text("Table 2, second row."),
		M: PDFString.of("D:20231013090000+02'00'"),
		F: 28,
		Name: PDFName.of("Comment"),
	});
	add(p1, {
		Type: "Annot",
		Subtype: "Text",
		Rect: [40, 640, 60, 660],
		IRT: reply,
		RT: PDFName.of("R"),
		NM: PDFString.of("9a8b7c6d-2222-4c3a-8f00-5b2d9e6a4c21"),
		T: text("Reviewer 1"),
		Contents: text("Thanks, found it."),
		M: PDFString.of("D:20231014100000+02'00'"),
		F: 30,
	});
	// Preview (Apple): AAPL:AKExtras, author from the user's full name, a strikeout and a sticky note.
	const sRects = [lineRect(1, 20, 160)];
	add(p1, {
		Type: "Annot",
		Subtype: "StrikeOut",
		Rect: union(sRects),
		QuadPoints: quads(sRects),
		T: text("Grace Hopper"),
		M: PDFString.of("D:20240102120000Z"),
		F: 4,
		C: [0.98, 0.2, 0.2],
		"AAPL:AKExtras": { "AAPL:AKAnnotationObject": PDFString.of("<plist/>") },
	});
	add(p1, {
		Type: "Annot",
		Subtype: "Text",
		Rect: [560, 520, 580, 540],
		T: text("Grace Hopper"),
		Contents: text("Compare with Walker 2009"),
		M: PDFString.of("D:20240102120500Z"),
		Name: PDFName.of("Note"),
		F: 4,
		C: [1, 0.9, 0.4],
		"AAPL:AKExtras": { "AAPL:AKAnnotationObject": PDFString.of("<plist/>") },
	});
	add(p1, {
		Type: "Annot",
		Subtype: "Ink",
		Rect: [300, 100, 420, 160],
		InkList: [
			[310, 110, 340, 150, 370, 120, 410, 150],
			[310, 105, 410, 105],
		],
		T: text("Grace Hopper"),
		F: 4,
		C: [0, 0.3, 0.9],
		BS: { W: 2 },
	});
	add(p1, {
		Type: "Annot",
		Subtype: "FreeText",
		Rect: [56, 60, 280, 84],
		Contents: text("See supplementary figure S3"),
		DA: PDFString.of("/Helv 11 Tf 0.8 0 0 rg"),
		T: text("Reviewer 1"),
		F: 4,
	});
	add(p1, { Type: "Annot", Subtype: "Text", Rect: [20, 20, 40, 40], Contents: text("hidden"), F: 2 });
	// Anara's export (DocumentMenu → bake-annotations): a Comment note tagged with the annotation id.
	add(p1, {
		Type: "Annot",
		Subtype: "Text",
		Name: PDFName.of("Comment"),
		Rect: [38, 682, 56, 700],
		Contents: text("My own note from Anara"),
		T: text("Cristian"),
		NM: PDFString.of("anara:clx0anaraannot01"),
		C: [0.79, 0.54, 0.02],
		F: 4,
		Open: false,
	});

	// A page shown rotated 90° clockwise.
	const p2 = doc.addPage([W, H]);
	fill(p2, [0]);
	p2.node.set(PDFName.of("Rotate"), doc.context.obj(90));
	add(p2, {
		Type: "Annot",
		Subtype: "Highlight",
		Rect: ROTATED_RECT,
		QuadPoints: quads([ROTATED_RECT]),
		T: text("Ada Lovelace"),
		NM: PDFString.of("Zotero-ROT90000"),
		F: 4,
		C: yellow,
	});
	return doc.save();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const out = new URL("../../demo/public/annotations.pdf", import.meta.url);
	writeFileSync(out, await annotated());
	console.info(`wrote ${fileURLToPath(out)}`);
}
