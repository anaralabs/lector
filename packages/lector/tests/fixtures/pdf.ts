/** Small deterministic, valid PDF fixture. No network or binary fixture download. */
export function createTextPdf(pageCount: number, lines = 20): Uint8Array {
	const fontId = 3 + pageCount * 2;
	const objects: string[] = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] >>`,
	];
	for (let i = 0; i < pageCount; i++) {
		const text = `BT /F1 11 Tf 40 750 Td 14 TL ${Array.from({ length: lines }, (_, line) => `1 0 0 1 40 ${750 - (line % 50) * 14} Tm (Page ${i + 1} line ${line + 1}: searchable documents and efficient page navigation.) Tj`).join(" ")} ET`;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
			`<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
		);
	}
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	let pdf = "%PDF-1.7\n";
	const offsets = [0];
	objects.forEach((object, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join(
			"",
		)}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}
