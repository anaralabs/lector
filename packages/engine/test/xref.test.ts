import assert from "node:assert/strict";
import { test } from "node:test";
import { findStartxref, pagePathObjects, parseXref } from "../src/xref.ts";

/** A minimal PDF: objects as [num, body], written in order, with a classic xref table. */
function pdf(objects: [number, string][], root: number) {
	let out = "%PDF-1.4\n";
	const offsets = new Map<number, number>();
	for (const [num, body] of objects) {
		offsets.set(num, out.length);
		out += `${num} 0 obj\n${body}\nendobj\n`;
	}
	const max = Math.max(...offsets.keys());
	const xrefAt = out.length;
	out += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
	for (let i = 1; i <= max; i++) out += `${String(offsets.get(i) ?? 0).padStart(10, "0")} 00000 ${offsets.has(i) ? "n" : "f"} \n`;
	out += `trailer\n<< /Size ${max + 1} /Root ${root} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
	return { bytes: new TextEncoder().encode(out), offsets };
}

const reader = (bytes: Uint8Array) => {
	const reads: number[] = [];
	return {
		reads,
		read: async (_num: number, offset: number) => (reads.push(offset), bytes.subarray(offset, offset + 4096)),
		readMany: async (objects: [number, number][]) => objects.map(([, o]) => (reads.push(o), bytes.subarray(o, o + 4096))),
	};
};

const page = (parent: number) => `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 612 792] >>`;

test("flat tree: the kids up to the target and two after", async () => {
	// 1 catalog, 2 pages, 3..42 forty pages (each followed by filler, like an image)
	const objects: [number, string][] = [
		[1, "<< /Type /Catalog /Pages 2 0 R >>"],
		[2, `<< /Type /Pages /Count 40 /Kids [${Array.from({ length: 40 }, (_, i) => `${i + 3} 0 R`).join(" ")}] >>`],
	];
	for (let i = 0; i < 40; i++) objects.push([i + 3, `${page(2)}\n% ${"x".repeat(500)}`]);
	const { bytes, offsets } = pdf(objects, 1);
	const startxref = findStartxref(bytes)!;
	const xref = parseXref(bytes, 0, startxref)!;
	assert.equal(xref.offsets.get(7), offsets.get(7));
	const path = await pagePathObjects(xref, 31, reader(bytes));
	assert.deepEqual(path, [offsets.get(2), ...Array.from({ length: 34 }, (_, i) => offsets.get(i + 3))]);
	// A fraction resolves against the root's /Count.
	const half = await pagePathObjects(xref, (n) => n / 2, reader(bytes));
	assert.equal(half!.length, 1 + 23);
});

test("nested tree: only the subtree holding the target is walked", async () => {
	// root 2 -> [10 (pages 0-9), 11 (pages 10-19)]
	const objects: [number, string][] = [[1, "<< /Type /Catalog /Pages 2 0 R >>"], [2, "<< /Type /Pages /Count 20 /Kids [10 0 R 11 0 R] >>"]];
	const kids = (from: number) => Array.from({ length: 10 }, (_, i) => `${from + i} 0 R`).join(" ");
	objects.push([10, `<< /Type /Pages /Parent 2 0 R /Count 10 /Kids [${kids(20)}] >>`]);
	objects.push([11, `<< /Type /Pages /Parent 2 0 R /Count 10 /Kids [${kids(30)}] >>`]);
	for (let i = 0; i < 10; i++) objects.push([20 + i, page(10)], [30 + i, page(11)]);
	const { bytes, offsets } = pdf(objects, 1);
	const xref = parseXref(bytes, 0, findStartxref(bytes)!)!;
	const path = await pagePathObjects(xref, 14, reader(bytes));
	assert.ok(path);
	assert.ok(path.includes(offsets.get(11)!));
	for (let i = 30; i <= 36; i++) assert.ok(path.includes(offsets.get(i)!), `page object ${i}`);
	for (let i = 20; i < 30; i++) assert.ok(!path.includes(offsets.get(i)!), `skipped subtree object ${i}`);
});

test("xref streams and tables outside the bytes give up (workers read on demand)", () => {
	const stream = new TextEncoder().encode("%PDF-1.5\n1 0 obj\n<< /Type /XRef >>\nstream\n...\nendstream\nendobj\nstartxref\n9\n%%EOF\n");
	assert.equal(parseXref(stream, 0, findStartxref(stream)!), null);
	assert.equal(parseXref(stream, 100, 9), null);
});
