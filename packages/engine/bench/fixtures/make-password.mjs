// Generates demo/public/password.pdf (AES-256, user password "secret").
// Usage: node bench/fixtures/make-password.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts } = require(process.env.PDF_LIB ?? "pdf-lib");
const mupdf = await import(process.env.MUPDF ? pathToFileURL(`${process.env.MUPDF}/dist/mupdf.js`).href : "mupdf");

const doc = await PDFDocument.create();
doc.setTitle("Locked fixture");
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 2; i++) doc.addPage([612, 792]).drawText(`Unlocked page ${i + 1}: the password was right`, { x: 72, y: 700, size: 16, font });
const plain = await doc.save();
const locked = new mupdf.PDFDocument(plain).saveToBuffer("encrypt=aes-256,user-password=secret,owner-password=owner").asUint8Array();
const out = new URL("../../demo/public/password.pdf", import.meta.url);
writeFileSync(out, locked);
console.log(`wrote ${out.pathname} (${locked.length} bytes)`);
