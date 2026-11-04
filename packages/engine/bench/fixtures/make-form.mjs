// Generates two AcroForm fixtures in demo/public:
// - form-noap.pdf: filled fields whose widgets have no appearance streams
//   (NeedAppearances), which only render through the form fill environment.
// - form.pdf: one of each field kind to fill in (text, multiline, checkbox,
//   radio group, dropdown, list box), with the name field repeated on page 2.
// Usage: node bench/fixtures/make-form.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFBool, StandardFonts } = require(process.env.PDF_LIB ?? "pdf-lib");

export async function noAppearances() {
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
	return doc.save({ updateFieldAppearances: false });
}

export async function fillable() {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const page = doc.addPage([612, 792]);
	const label = (p, text, y) => p.drawText(text, { x: 72, y: y + 6, size: 12, font });
	page.drawText("Fillable form", { x: 72, y: 720, size: 18, font });
	page.drawText("Selectable text outside the fields.", { x: 72, y: 690, size: 12, font });
	const form = doc.getForm();
	label(page, "Name:", 640);
	const name = form.createTextField("name");
	name.addToPage(page, { x: 160, y: 640, width: 250, height: 24, font });
	label(page, "Notes:", 560);
	const notes = form.createTextField("notes");
	notes.enableMultiline();
	notes.addToPage(page, { x: 160, y: 520, width: 250, height: 64, font });
	label(page, "Agree:", 480);
	form.createCheckBox("agree").addToPage(page, { x: 160, y: 480, width: 18, height: 18 });
	label(page, "Size:", 440);
	const size = form.createRadioGroup("size");
	size.addOptionToPage("small", page, { x: 160, y: 440, width: 18, height: 18 });
	size.addOptionToPage("large", page, { x: 220, y: 440, width: 18, height: 18 });
	label(page, "Color:", 390);
	const color = form.createDropdown("color");
	color.addOptions(["Red", "Green", "Blue"]);
	color.select("Red");
	color.addToPage(page, { x: 160, y: 390, width: 150, height: 24, font });
	label(page, "Fruit:", 320);
	const fruit = form.createOptionList("fruit");
	fruit.addOptions(["Apple", "Banana", "Cherry"]);
	fruit.addToPage(page, { x: 160, y: 290, width: 150, height: 54, font });
	const page2 = doc.addPage([612, 792]);
	page2.drawText("Page 2: the name field again", { x: 72, y: 720, size: 18, font });
	name.addToPage(page2, { x: 160, y: 640, width: 250, height: 24, font });
	form.updateFieldAppearances(font);
	return doc.save();
}

const out = (name, bytes) => {
	writeFileSync(new URL(`../../demo/public/${name}`, import.meta.url), bytes);
	console.log(`${name}: ${bytes.length} bytes`);
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	out("form-noap.pdf", await noAppearances());
	out("form.pdf", await fillable());
}
