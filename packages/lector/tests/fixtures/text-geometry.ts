/** PDF operators remain visible so geometry regressions are easy to reproduce. */
export function createTextGeometryPdf({
	rotation = 0,
	crop = false,
	operators = "BT /F1 20 Tf 1 0 0 1 100 500 Tm (READER) Tj ET",
}: {
	rotation?: number;
	crop?: boolean;
	operators?: string;
} = {}) {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] ${crop ? "/CropBox [50 100 550 700]" : ""} /Rotate ${rotation} /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
		`<< /Length ${operators.length} >>\nstream\n${operators}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let pdf = "%PDF-1.7\n";
	const offsets = [0];
	for (const [i, object] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join(
			"",
		)}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}
