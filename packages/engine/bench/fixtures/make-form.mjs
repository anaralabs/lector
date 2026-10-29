// Generates demo/public/form-noap.pdf: filled AcroForm fields whose widgets have
// no appearance streams (NeedAppearances), which only render through the form
// fill environment (FPDF_FFLDraw).
// Usage: PDF_LIB=/path/to/pdf-lib node bench/fixtures/make-form.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFBool, StandardFonts } = require(process.env.PDF_LIB ?? "/Users/giga/fun/anara-engine/node_modules/.pnpm/pdf-lib@1.17.1/node_modules/pdf-lib");
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([612, 792]);
page.drawText("Form without appearance streams", { x: 72, y: 720, size: 18, font });
page.drawText("Name:", { x: 72, y: 650, size: 12, font });
page.drawText("Agree:", { x: 72, y: 600, size: 12, font });
const form = doc.getForm();
const name = form.createTextField("name");
name.setText("Ada Lovelace");
name.addToPage(page, { x: 130, y: 640, width: 250, height: 24 });
const agree = form.createCheckBox("agree");
agree.addToPage(page, { x: 130, y: 595, width: 18, height: 18 });
agree.check();
const empty = form.createTextField("empty");
empty.addToPage(page, { x: 130, y: 550, width: 250, height: 24 });
// Drop every widget appearance; viewers must generate them.
for (const field of form.getFields()) for (const w of field.acroField.getWidgets()) w.dict.delete(PDFName.of("AP"));
form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
const bytes = await doc.save({ updateFieldAppearances: false });
writeFileSync(new URL("../../demo/public/form-noap.pdf", import.meta.url), bytes);
console.log(`form-noap.pdf: ${bytes.length} bytes`);
