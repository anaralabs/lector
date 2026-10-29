// Generates demo/public/password.pdf (AES-256, user password "secret").
// Usage: PDF_LIB=/path/to/pdf-lib MUPDF=/path/to/mupdf node bench/fixtures/make-password.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pnpm = "/Users/giga/fun/anara-engine/node_modules/.pnpm";
const { PDFDocument, StandardFonts } = require(process.env.PDF_LIB ?? `${pnpm}/pdf-lib@1.17.1/node_modules/pdf-lib`);
const mupdf = await import(pathToFileURL(`${process.env.MUPDF ?? `${pnpm}/mupdf@1.27.0/node_modules/mupdf`}/dist/mupdf.js`).href);

const doc = await PDFDocument.create();
doc.setTitle("Locked fixture");
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 2; i++) doc.addPage([612, 792]).drawText(`Unlocked page ${i + 1}: the password was right`, { x: 72, y: 700, size: 16, font });
const plain = await doc.save();
const locked = new mupdf.PDFDocument(plain).saveToBuffer("encrypt=aes-256,user-password=secret,owner-password=owner").asUint8Array();
const out = new URL("../../demo/public/password.pdf", import.meta.url);
writeFileSync(out, locked);
console.log(`wrote ${out.pathname} (${locked.length} bytes)`);
