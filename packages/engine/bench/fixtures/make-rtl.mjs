// Generates demo/public/rtl.pdf: Hebrew lines (written in visual order, as PDF
// generators do; PDFium's text page reorders them to logical order) plus an
// LTR control line. Glyphs are Helvetica's (no Hebrew font is needed): a
// ToUnicode CMap maps them to Hebrew, which is all text extraction sees.
// Usage: node bench/fixtures/make-rtl.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFString, StandardFonts, beginText, endText, setFontAndSize, moveText, showText } = require(
	process.env.PDF_LIB ?? "pdf-lib",
);
// a..e -> shin, lamed, vav, final mem, ayin; space stays a space.
const map = { a: 0x05e9, b: 0x05dc, c: 0x05d5, d: 0x05dd, e: 0x05e2, " ": 0x20 };
const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def /CMapType 2 def
1 begincodespacerange <00> <FF> endcodespacerange
${Object.keys(map).length} beginbfchar
${Object.entries(map)
	.map(([k, u]) => `<${k.charCodeAt(0).toString(16).padStart(2, "0")}> <${u.toString(16).padStart(4, "0")}>`)
	.join("\n")}
endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const helv = await doc.embedFont(StandardFonts.Helvetica);
page.drawText("LTR control line", { x: 72, y: 720, size: 18, font: helv });
const toUnicode = doc.context.register(doc.context.stream(cmap));
const font = doc.context.register(doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding", ToUnicode: toUnicode }));
page.node.setFontDictionary(PDFName.of("FH"), font);
// Logical "שלום עולם" = a b c d ␠ e c b d; written visually (left to right) reversed.
const visual = (logical) => [...logical].reverse().join("");
for (const [i, logical] of ["abcd ecbd", "ecbd abcd abcd"].entries()) {
	page.pushOperators(beginText(), setFontAndSize("FH", 24), moveText(320 - i * 60, 640 - i * 50), showText(PDFString.of(visual(logical))), endText());
}
const bytes = await doc.save();
writeFileSync(new URL("../../demo/public/rtl.pdf", import.meta.url), bytes);
console.log(`rtl.pdf: ${bytes.length} bytes`);
