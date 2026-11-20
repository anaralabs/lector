// Pages with multi-line text and "fi" ligatures (one glyph, ToUnicode "fi"), one per /Rotate.
const LINES = ["The \x80rst line of the \x80eld notes", "a second line, de\x80ned here", "\x80nal line, three \x80gures"];

/** A PDF with one 400x600 page per angle in `rotations`; text drawn upright in user space. */
export function makeRotated(rotations = [0, 90, 180, 270]) {
	const objs = [];
	const add = (s) => objs.push(s) && objs.length;
	const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Rot def /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <20> <7E> <0020> endbfrange 1 beginbfchar <80> <00660069> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
	const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
	const pagesObj = add(null);
	const toUnicode = add(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
	const font = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [128 /fi] >> /ToUnicode ${toUnicode} 0 R >>`);
	const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
	const body = `BT /F1 14 Tf 18 TL 50 500 Td ${LINES.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
	const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
	const kids = rotations.map((r) => add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Rotate ${r} /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
	objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
	let out = "%PDF-1.7\n";
	const offsets = objs.map((o, i) => {
		const at = out.length;
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
		return at;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

export const ROTATED_LINES = LINES.map((l) => l.replaceAll("\x80", "fi"));
