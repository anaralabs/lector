// Synthetic PDFs written the way scanners and office suites lay them out:
// catalog and page tree first, page content after, xref and trailer last.
// `xrefStream` stores the catalog, pages tree and page dictionaries in a
// compressed object stream indexed by an xref stream (PDF 1.5).
import { deflateSync } from "node:zlib";

/** Pseudo-random bytes (deterministic) so streams don't compress away. */
function noise(n, seed) {
	const out = new Uint8Array(n);
	let x = seed * 2654435761 >>> 0 || 1;
	for (let i = 0; i < n; i++) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		out[i] = x & 0xff;
	}
	return out;
}

const enc = (s) => new TextEncoder().encode(s);

/**
 * @param {{ pages?: number, bytes?: number, xrefStream?: boolean, updates?: number }} o
 * `bytes`: about how large the file is; `updates`: incremental updates appended (each its own xref section);
 * `preamble`: bytes of text in front of `%PDF-` (prepended afterwards, so the offsets count from the header).
 */
export function makeUnlinearized({ pages = 20, bytes = 1 << 20, xrefStream = false, updates = 0, preamble = 0 } = {}) {
	const parts = [];
	let len = 0;
	const push = (b) => {
		const u = typeof b === "string" ? enc(b) : b;
		parts.push(u);
		len += u.length;
	};
	const offsets = new Map();
	push("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
	const pageNum = (i) => 3 + i * 3;
	const contentNum = (i) => 4 + i * 3;
	const imageNum = (i) => 5 + i * 3;
	const size = 3 + pages * 3;
	const kids = Array.from({ length: pages }, (_, i) => `${pageNum(i)} 0 R`).join(" ");
	const dicts = new Map([[1, "<< /Type /Catalog /Pages 2 0 R >>"], [2, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`]]);
	for (let i = 0; i < pages; i++) dicts.set(pageNum(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum(i)} 0 R /Resources << /XObject << /Im0 ${imageNum(i)} 0 R >> >> >>`);
	const inStream = new Map();
	let objstmNum = 0;
	if (xrefStream) {
		objstmNum = size;
		const nums = [...dicts.keys()];
		let header = "";
		let body = "";
		nums.forEach((n, idx) => {
			header += `${n} ${body.length} `;
			body += `${dicts.get(n)}\n`;
			inStream.set(n, idx);
		});
		const data = deflateSync(enc(header + body));
		offsets.set(objstmNum, len);
		push(`${objstmNum} 0 obj\n<< /Type /ObjStm /N ${nums.length} /First ${header.length} /Length ${data.length} /Filter /FlateDecode >>\nstream\n`);
		push(data);
		push("\nendstream\nendobj\n");
	} else {
		for (const [n, d] of dicts) {
			offsets.set(n, len);
			push(`${n} 0 obj\n${d}\nendobj\n`);
		}
	}
	const per = Math.max(64, Math.floor(bytes / pages) - 400);
	for (let i = 0; i < pages; i++) {
		const ops = enc(`q 400 0 0 400 100 300 cm /Im0 Do Q BT /F1 24 Tf 50 700 Td (Page ${i + 1}) Tj ET`);
		offsets.set(contentNum(i), len);
		push(`${contentNum(i)} 0 obj\n<< /Length ${ops.length} >>\nstream\n`);
		push(ops);
		push("\nendstream\nendobj\n");
		const side = Math.floor(Math.sqrt(per / 3));
		const img = noise(side * side * 3, i + 1);
		offsets.set(imageNum(i), len);
		push(`${imageNum(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${img.length} >>\nstream\n`);
		push(img);
		push("\nendstream\nendobj\n");
	}
	let total = size + (xrefStream ? 2 : 0);
	let prev = -1;
	const writeXref = (entries, root) => {
		const xrefAt = len;
		if (xrefStream) {
			const xnum = total - 1;
			const rows = [];
			const all = new Map(entries);
			all.set(xnum, xrefAt);
			for (let n = 0; n < total; n++) {
				if (inStream.has(n) && !entries.has(n)) rows.push([2, objstmNum, inStream.get(n)]);
				else if (all.has(n)) rows.push([1, all.get(n), 0]);
				else rows.push([0, 0, 0]);
			}
			const data = new Uint8Array(rows.length * 6);
			rows.forEach(([t, a, b], i) => {
				data[i * 6] = t;
				data[i * 6 + 1] = (a >>> 24) & 0xff;
				data[i * 6 + 2] = (a >>> 16) & 0xff;
				data[i * 6 + 3] = (a >>> 8) & 0xff;
				data[i * 6 + 4] = a & 0xff;
				data[i * 6 + 5] = b;
			});
			push(`${xnum} 0 obj\n<< /Type /XRef /Size ${total} /W [1 4 1] /Root ${root} 0 R${prev >= 0 ? ` /Prev ${prev}` : ""} /Length ${data.length} >>\nstream\n`);
			push(data);
			push(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`);
		} else {
			let t = `xref\n0 1\n0000000000 65535 f \n`;
			for (const [n, off] of [...entries].sort((a, b) => a[0] - b[0])) t += `${n} 1\n${String(off).padStart(10, "0")} 00000 n \n`;
			push(`${t}trailer\n<< /Size ${total} /Root ${root} 0 R${prev >= 0 ? ` /Prev ${prev}` : ""} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
		}
		prev = xrefAt;
	};
	writeXref(offsets, 1);
	for (let u = 0; u < updates; u++) {
		// a new Info object and a rewritten catalog, as an editor's incremental save does
		const info = total;
		total += xrefStream ? 2 : 1;
		const changed = new Map();
		changed.set(info, len);
		push(`${info} 0 obj\n<< /Producer (update ${u + 1}) >>\nendobj\n`);
		changed.set(1, len);
		push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Lang (en) >>\nendobj\n`);
		writeXref(changed, 1);
	}
	const out = new Uint8Array(preamble + len).fill(0x41, 0, preamble);
	let at = preamble;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}
