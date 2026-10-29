// Generates demo/public/big.pdf: cadbots.pdf repeated N times (default 40) for
// large-file loading/memory measurements. Not committed (gitignored, ~70MB).
// Usage: PDF_LIB=/path/to/pdf-lib node bench/fixtures/make-big.mjs [copies]
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PDFDocument } = require(process.env.PDF_LIB ?? "/Users/giga/fun/anara-engine/node_modules/.pnpm/pdf-lib@1.17.1/node_modules/pdf-lib");
const copies = Number(process.argv[2] ?? 40);
const src = await PDFDocument.load(readFileSync(new URL("../../demo/public/cadbots.pdf", import.meta.url)));
const out = await PDFDocument.create();
for (let i = 0; i < copies; i++) {
	// Copy each round separately, so resources are duplicated like a real big file.
	const pages = await out.copyPages(src, src.getPageIndices());
	for (const p of pages) out.addPage(p);
}
const bytes = await out.save({ useObjectStreams: process.env.OBJSTM === "1" });
writeFileSync(new URL(`../../demo/public/${process.env.OUT ?? "big.pdf"}`, import.meta.url), bytes);
console.log(`big.pdf: ${out.getPageCount()} pages, ${(bytes.length / 1048576).toFixed(1)} MB`);
