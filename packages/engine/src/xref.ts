// Just enough PDF syntax to find where the page tree's objects live, so the
// main thread can fetch, in parallel, the dictionaries PDFium will read one by
// one (one synchronous request each) before it can open a page in the middle.
// Classic xref tables only; anything else returns null and the workers read
// on demand. No runtime imports: tests load this file in Node.

const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

/** `startxref` offset from the file's last bytes. */
export function findStartxref(tail: Uint8Array): number | null {
	const text = latin1(tail.subarray(Math.max(0, tail.length - 2048)));
	const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text) ?? /startxref\s+(\d+)/.exec(text);
	return m ? Number(m[1]) : null;
}

/**
 * Object number -> byte offset from a classic xref table at `at` in `bytes`
 * (which start at file offset `base`), plus its trailer. Null for an xref
 * stream or a table that is not all inside `bytes`.
 */
export function parseXref(bytes: Uint8Array, base: number, at: number): { offsets: Map<number, number>; trailer: string } | null {
	if (at < base || at >= base + bytes.length) return null;
	const text = latin1(bytes.subarray(at - base));
	if (!text.startsWith("xref")) return null;
	const offsets = new Map<number, number>();
	let pos = 4;
	const section = /\s*(\d+)\s+(\d+)\s*/y;
	const entry = /(\d{10}) (\d{5}) ([nf])\s{0,2}/y;
	for (;;) {
		section.lastIndex = pos;
		const s = section.exec(text);
		if (!s) break;
		pos = section.lastIndex;
		const first = Number(s[1]);
		const count = Number(s[2]);
		for (let i = 0; i < count; i++) {
			entry.lastIndex = pos;
			const e = entry.exec(text);
			if (!e) return null;
			pos = entry.lastIndex;
			if (e[3] === "n" && !offsets.has(first + i)) offsets.set(first + i, Number(e[1]));
		}
	}
	const trailer = /^\s*trailer\s*(<<[\s\S]*?>>)\s*startxref/.exec(text.slice(pos))?.[1];
	return trailer ? { offsets, trailer } : null;
}

/** `/Key n g R` in a dictionary's text. */
export function refOf(dict: string, key: string): number | null {
	const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
	return m ? Number(m[1]) : null;
}

/** Object numbers in `/Kids [ ... ]`. */
export function kidsOf(dict: string): number[] | null {
	const m = /\/Kids\s*\[([^\]]*)\]/.exec(dict);
	if (!m) return null;
	return [...m[1]!.matchAll(/(\d+)\s+\d+\s+R/g)].map((k) => Number(k[1]));
}

export function countOf(dict: string): number | null {
	const m = /\/Count\s+(\d+)/.exec(dict);
	return m ? Number(m[1]) : null;
}

/** The text of object `num` read from bytes starting at its offset (up to `endobj`, or all of it). */
export function objectText(bytes: Uint8Array, num: number): string | null {
	const text = latin1(bytes);
	const head = new RegExp(`^\\s*${num}\\s+\\d+\\s+obj`).exec(text);
	if (!head) return null;
	const end = text.indexOf("endobj", head[0].length);
	return text.slice(head[0].length, end < 0 ? undefined : end);
}

export interface PageTreeReader {
	/** bytes of object `num` from its offset (enough to hold its dictionary) */
	read(num: number, offset: number): Promise<Uint8Array | null>;
	/** many objects at once (fetched in parallel) */
	readMany(objects: [number, number][]): Promise<(Uint8Array | null)[]>;
}

/**
 * The objects PDFium loads to reach `target`: every kid before it in each
 * node along its path (PDFium reads a kid to learn whether it is a page or a
 * subtree), plus the target and the next two pages. Offsets, for prefetching.
 */
export async function pagePathObjects(xref: { offsets: Map<number, number>; trailer: string }, target: number | ((pageCount: number) => number), reader: PageTreeReader): Promise<number[] | null> {
	const { offsets, trailer } = xref;
	const at = (num: number | null) => (num === null ? undefined : offsets.get(num));
	const rootNum = refOf(trailer, "Root");
	const rootAt = at(rootNum);
	if (rootAt === undefined) return null;
	const rootBytes = await reader.read(rootNum!, rootAt);
	const catalog = rootBytes && objectText(rootBytes, rootNum!);
	let nodeNum = catalog ? refOf(catalog, "Pages") : null;
	const wanted: number[] = [];
	let skip = typeof target === "number" ? target : -1;
	for (let depth = 0; depth < 8 && nodeNum !== null; depth++) {
		const nodeAt = at(nodeNum);
		if (nodeAt === undefined) return null;
		wanted.push(nodeAt);
		const bytes = await reader.read(nodeNum, nodeAt);
		const node = bytes && objectText(bytes, nodeNum);
		const kids = node ? kidsOf(node) : null;
		if (!kids || kids.length === 0) return null;
		const kidAt = kids.map((k) => at(k));
		if (kidAt.some((o) => o === undefined)) return null;
		const count = countOf(node!);
		if (skip < 0) skip = count ? Math.max(0, Math.min(count - 1, Math.floor((target as (n: number) => number)(count)))) : 0;
		// Every kid is one page: the target is kid `skip`, and PDFium reads the kids before it.
		if (count === kids.length) {
			const last = Math.min(kids.length - 1, skip + 2);
			for (let i = 0; i <= last; i++) wanted.push(kidAt[i]!);
			return wanted;
		}
		// Subtrees: read every kid's /Count to find which one holds the target.
		const texts = await reader.readMany(kids.map((k, i) => [k, kidAt[i]!]));
		let next: number | null = null;
		for (let i = 0; i < kids.length; i++) {
			wanted.push(kidAt[i]!);
			const t = texts[i] && objectText(texts[i]!, kids[i]!);
			if (!t) return null;
			const n = /\/Type\s*\/Pages\b/.test(t) ? countOf(t) : 1;
			if (n === null) return null;
			if (skip < n) {
				next = n > 1 || /\/Type\s*\/Pages\b/.test(t) ? kids[i]! : null;
				if (next === null) return wanted;
				break;
			}
			skip -= n;
		}
		nodeNum = next;
	}
	return null;
}
