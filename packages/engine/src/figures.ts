// Figures, charts, diagrams and tables on a page, found from PDFium page objects
// (images, vector paths) and the page text (captions). `readFigureInput` runs in
// the raster workers; `detectFigures` is pure so it can be tested on its own.

import type { Pdfium } from "./pdfium/pdfium.js";
import type { Rect } from "./text";

export type FigureKind = "image" | "vector" | "table";

export interface PageFigure {
	page: number;
	/** page points, top-left origin, as displayed; includes axis labels but not the caption */
	rect: Rect;
	kind: FigureKind;
	/** "Figure 3", "Table 2", "Fig. 4b" as printed */
	label?: string;
	caption?: { text: string; rect: Rect };
}

/** [x0, y0, x1, y1] in page points, top-left origin */
export type Box = [number, number, number, number];

export interface FigureLine {
	text: string;
	box: Box;
}

export interface FigureInput {
	page: number;
	w: number;
	h: number;
	images: Box[];
	paths: Box[];
	lines: FigureLine[];
}

/** paths closer than this (points) belong to the same graphic */
const JOIN_GAP = 8;
/** a path thinner than this, and long for its width, is a rule (table line, underline, fraction bar) */
const RULE_MAX = 3;
/** smallest graphic worth a menu, as a fraction of the page, and in points per side */
const MIN_AREA_FRACTION = 0.012;
const MIN_SIDE = 36;
/** paths an uncaptioned vector graphic needs, so lone boxes and frames stay out */
const MIN_UNCAPTIONED_PATHS = 6;
/** a graphic covering more of the page than this is a page background, not a figure */
const MAX_AREA_FRACTION = 0.85;
/** an uncaptioned image this big is a scanned page */
const SCAN_AREA_FRACTION = 0.7;
/** how far (fraction of page height) a caption may sit from its graphic */
const CAPTION_REACH = 0.22;
const MAX_CAPTION_LINES = 12;
const MAX_CAPTION_CHARS = 800;

const CAPTION =
	/^\s*((?:figure|fig\.?|table|tab\.|exhibit|chart|scheme|plate)\s*(?:[a-z]?\d+(?:\.\d+)*[a-z]?|[ivxlc]+))(\s*[:.|—–-]|\s|$)/i;

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const union = (a: Box, b: Box): Box => [
	Math.min(a[0], b[0]),
	Math.min(a[1], b[1]),
	Math.max(a[2], b[2]),
	Math.max(a[3], b[3]),
];
const grow = (b: Box, dx: number, dy = dx): Box => [
	b[0] - dx,
	b[1] - dy,
	b[2] + dx,
	b[3] + dy,
];
const hits = (a: Box, b: Box) =>
	a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const overlapX = (a: Box, b: Box) =>
	Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
const overlapY = (a: Box, b: Box) =>
	Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const inside = (a: Box, b: Box) => {
	const ix = overlapX(a, b);
	const iy = overlapY(a, b);
	return area(a) > 0 ? (ix * iy) / area(a) : 0;
};
const toRect = (b: Box): Rect => ({
	x: b[0],
	y: b[1],
	w: b[2] - b[0],
	h: b[3] - b[1],
});

interface Region {
	box: Box;
	paths: number;
	rules: number;
	imageArea: number;
}

/** grid resolution (points) for connected components */
const CELL = 2;

/** Connected components of the items' boxes grown by half the join gap, on an occupancy grid: linear in items. */
function cluster(
	items: { box: Box; image: boolean; rule: boolean }[],
	w: number,
	h: number,
): Region[] {
	const gw = Math.ceil(w / CELL) + 1;
	const gh = Math.ceil(h / CELL) + 1;
	const diff = new Int32Array((gw + 1) * (gh + 1));
	const cells = items.map((it) => {
		const b = grow(it.box, JOIN_GAP / 2);
		const x0 = Math.max(0, Math.floor(b[0] / CELL));
		const y0 = Math.max(0, Math.floor(b[1] / CELL));
		const x1 = Math.min(gw - 1, Math.floor(b[2] / CELL));
		const y1 = Math.min(gh - 1, Math.floor(b[3] / CELL));
		if (x1 < x0 || y1 < y0) return -1;
		diff[y0 * (gw + 1) + x0]!++;
		diff[y0 * (gw + 1) + x1 + 1]!--;
		diff[(y1 + 1) * (gw + 1) + x0]!--;
		diff[(y1 + 1) * (gw + 1) + x1 + 1]!++;
		return ((y0 + y1) >> 1) * gw + ((x0 + x1) >> 1);
	});
	const label = new Int32Array(gw * gh).fill(-1);
	const filled = new Uint8Array(gw * gh);
	const row = new Int32Array(gw + 1);
	for (let y = 0; y < gh; y++) {
		let run = 0;
		for (let x = 0; x < gw; x++) {
			run += diff[y * (gw + 1) + x]!;
			row[x] = row[x]! + run;
			filled[y * gw + x] = row[x]! > 0 ? 1 : 0;
		}
	}
	let next = 0;
	const stack: number[] = [];
	for (let start = 0; start < filled.length; start++) {
		if (!filled[start] || label[start]! >= 0) continue;
		label[start] = next;
		stack.push(start);
		while (stack.length) {
			const c = stack.pop()!;
			const x = c % gw;
			for (const n of [
				x > 0 ? c - 1 : -1,
				x < gw - 1 ? c + 1 : -1,
				c - gw,
				c + gw,
			]) {
				if (n < 0 || n >= filled.length || !filled[n] || label[n]! >= 0)
					continue;
				label[n] = next;
				stack.push(n);
			}
		}
		next++;
	}
	const groups = new Map<number, Region>();
	items.forEach((it, i) => {
		const cell = cells[i]!;
		if (cell < 0) return;
		const root = label[cell]!;
		const g = groups.get(root);
		const add = {
			paths: it.image ? 0 : 1,
			rules: it.rule ? 1 : 0,
			imageArea: it.image ? area(it.box) : 0,
		};
		if (!g) groups.set(root, { box: [...it.box], ...add });
		else {
			g.box = union(g.box, it.box);
			g.paths += add.paths;
			g.rules += add.rules;
			g.imageArea += add.imageArea;
		}
	});
	return mergeOverlapping(joinRules([...groups.values()]));
}

/** Booktabs-style tables are separate rules with text between: stacked rules of the same width become one region. */
function joinRules(regions: Region[]): Region[] {
	const ruleOnly = (r: Region) => r.paths === r.rules && r.imageArea === 0;
	const rules = regions.filter(ruleOnly).sort((a, b) => a.box[1] - b.box[1]);
	const others = regions.filter((r) => !ruleOnly(r));
	const out: Region[] = [];
	for (const r of rules) {
		const prev = out.findLast(
			(o) =>
				Math.abs(o.box[0] - r.box[0]) < 4 && Math.abs(o.box[2] - r.box[2]) < 4,
		);
		const between: Box | null = prev
			? [r.box[0], prev.box[3], r.box[2], r.box[1]]
			: null;
		if (
			prev &&
			between &&
			r.box[1] - prev.box[3] < 260 &&
			!others.some((o) => hits(o.box, between))
		) {
			prev.box = union(prev.box, r.box);
			prev.paths += r.paths;
			prev.rules += r.rules;
		} else out.push({ ...r, box: [...r.box] });
	}
	return [...others, ...out];
}

/** Clusters whose boxes overlap (an image on a vector frame, a legend over a plot) become one. */
function mergeOverlapping(regions: Region[]): Region[] {
	let changed = true;
	while (changed) {
		changed = false;
		outer: for (let i = 0; i < regions.length; i++)
			for (let j = i + 1; j < regions.length; j++) {
				const a = regions[i]!;
				const b = regions[j]!;
				if (
					overlapX(a.box, b.box) * overlapY(a.box, b.box) <=
					0.2 * Math.min(area(a.box), area(b.box))
				)
					continue;
				regions[i] = {
					box: union(a.box, b.box),
					paths: a.paths + b.paths,
					rules: a.rules + b.rules,
					imageArea: a.imageArea + b.imageArea,
				};
				regions.splice(j, 1);
				changed = true;
				break outer;
			}
	}
	return regions;
}

interface Caption {
	label: string;
	table: boolean;
	strong: boolean;
	text: string;
	box: Box;
	first: number;
	last: number;
}

/** Caption paragraphs: a line opening with "Figure 3:"-style text and the lines that continue it. */
export function findCaptions(
	lines: FigureLine[],
	blockers: Box[] = [],
): Caption[] {
	const out: Caption[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = CAPTION.exec(lines[i]!.text);
		if (!m) continue;
		const label = m[1]!.replace(/\s+/g, " ").trim();
		let box = lines[i]!.box;
		const parts = [lines[i]!.text.trim()];
		let last = i;
		for (let j = i + 1; j < lines.length && j - i < MAX_CAPTION_LINES; j++) {
			const prev = lines[last]!.box;
			const next = lines[j]!.box;
			const lh = prev[3] - prev[1];
			const gap = next[1] - prev[3];
			if (
				gap < -lh * 0.5 ||
				gap > lh * 0.7 ||
				overlapX(next, box) < 0.5 * (next[2] - next[0]) ||
				CAPTION.test(lines[j]!.text)
			)
				break;
			// A table's top rule between two lines ends the caption above it.
			if (
				blockers.some(
					(b) =>
						b[1] >= prev[3] - 2 &&
						b[1] <= next[3] &&
						overlapX(b, box) >= 0.4 * (box[2] - box[0]),
				)
			)
				break;
			box = union(box, next);
			parts.push(lines[j]!.text.trim());
			last = j;
		}
		const text = parts
			.join(" ")
			.replace(/(\p{L})-\s+(?=\p{Ll})/gu, "$1")
			.replace(/\s+/g, " ")
			.slice(0, MAX_CAPTION_CHARS);
		out.push({
			label,
			table: /^tab/i.test(label),
			strong: /[:.|—–-]/.test(m[2] ?? ""),
			text,
			box,
			first: i,
			last,
		});
		i = last;
	}
	return out;
}

/**
 * Vertical gap between a caption and a region on the asked side, or null when it is not there.
 * Path bounds ignore clipping, so a region may overshoot into its caption: it is cut at the caption.
 */
function gapTo(
	region: Box,
	caption: Box,
	side: "above" | "below",
): { gap: number; box: Box } | null {
	if (
		overlapX(region, caption) <
		0.3 * Math.min(region[2] - region[0], caption[2] - caption[0])
	)
		return null;
	const ch = caption[3] - caption[1];
	const slack = Math.min(ch, 36) + 16;
	if (side === "above") {
		if (region[3] <= caption[1] + 4)
			return { gap: Math.max(0, caption[1] - region[3]), box: region };
		if (region[1] < caption[1] - 20 && region[3] <= caption[3] + slack)
			return { gap: 0, box: [region[0], region[1], region[2], caption[1]] };
		return null;
	}
	if (region[1] >= caption[3] - 4)
		return { gap: Math.max(0, region[1] - caption[3]), box: region };
	if (region[3] > caption[3] + 20 && region[1] >= caption[1] - slack)
		return { gap: 0, box: [region[0], caption[3], region[2], region[3]] };
	return null;
}

/** a sentence of body text rather than a label */
const prose = (text: string) => text.split(/\s+/).length >= 5;

/**
 * Text that belongs to a graphic: tick labels, legends, panel letters, box labels.
 * Lines inside the graphic always count; short non-prose lines just outside it
 * count too, measured against the graphic itself so absorbing cannot snowball.
 */
function absorbText(
	box: Box,
	lines: FigureLine[],
	captionLines: Set<number>,
): Box {
	const width = box[2] - box[0];
	const isLabel = (line: FigureLine) =>
		line.box[2] - line.box[0] <= Math.max(60, width * 0.6) && !prose(line.text);
	let out = box;
	lines.forEach((line, i) => {
		if (!captionLines.has(i) && inside(line.box, grow(box, 2)) >= 0.9)
			out = union(out, line.box);
	});
	// Two rings of labels: tick labels, then the axis titles beyond them.
	for (let ring = 0; ring < 2; ring++) {
		const near = grow(out, 16, 18);
		let next = out;
		lines.forEach((line, i) => {
			if (
				!captionLines.has(i) &&
				isLabel(line) &&
				inside(line.box, near) >= 0.6
			)
				next = union(next, line.box);
		});
		if (next === out) break;
		out = next;
	}
	return out;
}

export function detectFigures(input: FigureInput): PageFigure[] {
	const { w, h } = input;
	const pageArea = w * h;
	if (pageArea <= 0) return [];
	const items: { box: Box; image: boolean; rule: boolean }[] = [];
	// A box or image under paragraphs (an abstract panel, a page background, an OCR scan) is layout.
	const underText = (b: Box) => {
		const over = input.lines.filter(
			(l) => inside(l.box, b) > 0.8 && prose(l.text),
		);
		const wide = over.filter(
			(l) => l.box[2] - l.box[0] >= 0.6 * (b[2] - b[0]),
		).length;
		const covered = over.reduce((sum, l) => sum + area(l.box), 0);
		return wide >= 3 || covered >= 0.2 * area(b);
	};
	for (const box of input.images)
		if (
			area(box) < MAX_AREA_FRACTION * pageArea &&
			box[2] - box[0] >= 4 &&
			box[3] - box[1] >= 4 &&
			!underText(box)
		)
			items.push({ box, image: true, rule: false });
	for (const box of input.paths) {
		const bw = box[2] - box[0];
		const bh = box[3] - box[1];
		if (area(box) >= MAX_AREA_FRACTION * pageArea || (bw < 0.5 && bh < 0.5))
			continue;
		items.push({
			box,
			image: false,
			rule:
				Math.min(bw, bh) < RULE_MAX && Math.max(bw, bh) > 12 * Math.min(bw, bh),
		});
	}
	const regions = cluster(items, w, h);
	const captions = findCaptions(
		input.lines,
		regions.map((r) => r.box),
	);
	const captionLines = new Set<number>();
	for (const c of captions)
		for (let i = c.first; i <= c.last; i++) captionLines.add(i);

	const claimed = new Set<Region>();
	const figures: {
		box: Box;
		kind: FigureKind;
		caption?: Caption;
		image: boolean;
		region: Region;
	}[] = [];
	const reach = CAPTION_REACH * h;
	// Every caption-region pairing, nearest first: a caption takes the closest free graphic on either side.
	const candidates: {
		cap: Caption;
		region: Region;
		side: "above" | "below";
		gap: number;
		box: Box;
	}[] = [];
	for (const cap of captions)
		for (const side of ["above", "below"] as const)
			for (const region of regions) {
				if (
					region.paths === region.rules &&
					region.imageArea === 0 &&
					!cap.table
				)
					continue;
				const hit = gapTo(region.box, cap.box, side);
				if (hit && hit.gap <= reach)
					candidates.push({ cap, region, side, ...hit });
			}
	// Which side captions sit on is a house style: captions with only one candidate side vote for the page.
	const votes = {
		table: { above: 0, below: 0 },
		figure: { above: 0, below: 0 },
	};
	for (const cap of captions) {
		const sides = new Set(
			candidates.filter((c) => c.cap === cap).map((c) => c.side),
		);
		if (sides.size === 1)
			votes[cap.table ? "table" : "figure"][[...sides][0]!]++;
	}
	const preferredSide = (cap: Caption) => {
		const v = votes[cap.table ? "table" : "figure"];
		if (v.above !== v.below) return v.above > v.below ? "above" : "below";
		return cap.table ? "below" : "above";
	};
	const pairs = candidates.map((c) => ({
		...c,
		score:
			c.gap +
			(c.side === preferredSide(c.cap) ? 0 : 8) +
			(c.cap.strong ? 0 : 12),
	}));
	pairs.sort((a, b) => a.score - b.score);
	const placed = new Set<Caption>();
	for (const best of pairs) {
		if (placed.has(best.cap) || claimed.has(best.region)) continue;
		const cap = best.cap;
		placed.add(cap);
		claimed.add(best.region);
		let box = best.box;
		const merged = [best.region];
		// Sub-panels (a), (b), ... sharing the caption: neighbours on the caption's side, within its span.
		const span = grow(union(cap.box, box), 12, 0);
		let grew = true;
		while (grew) {
			grew = false;
			for (const region of regions) {
				if (claimed.has(region) || area(region.box) < 0.002 * pageArea)
					continue;
				if (
					region.paths === region.rules &&
					region.imageArea === 0 &&
					!cap.table
				)
					continue;
				if (overlapX(region.box, span) < 0.9 * (region.box[2] - region.box[0]))
					continue;
				const onSide =
					best.side === "above"
						? region.box[3] <= cap.box[1] + 4
						: region.box[1] >= cap.box[3] - 4;
				const sameRow =
					overlapY(region.box, box) >= 0.5 * (region.box[3] - region.box[1]);
				if (!onSide || !(sameRow || hits(grow(box, 24, 24), region.box)))
					continue;
				claimed.add(region);
				merged.push(region);
				box = union(box, region.box);
				grew = true;
			}
		}
		const imageArea = merged.reduce((sum, r) => sum + r.imageArea, 0);
		figures.push({
			box,
			kind: cap.table ? "table" : "vector",
			caption: cap,
			image: imageArea >= 0.5 * area(box),
			region: best.region,
		});
	}

	for (const region of regions) {
		if (claimed.has(region)) continue;
		const b = region.box;
		const bw = b[2] - b[0];
		const bh = b[3] - b[1];
		if (
			bw < MIN_SIDE ||
			bh < MIN_SIDE ||
			area(b) < MIN_AREA_FRACTION * pageArea
		)
			continue;
		// Journal banners and footer logos
		if (bh < 0.1 * h && (b[3] < 0.15 * h || b[1] > 0.9 * h)) continue;
		const image = region.imageArea >= 0.5 * area(b);
		if (image && area(b) >= SCAN_AREA_FRACTION * pageArea) continue;
		if (!image && region.paths - region.rules < MIN_UNCAPTIONED_PATHS) continue;
		if (underText(b)) continue;
		figures.push({ box: b, kind: "vector", image, region });
	}

	const out: PageFigure[] = [];
	for (const f of figures) {
		let box = absorbText(f.box, input.lines, captionLines);
		box = [
			Math.max(0, box[0]),
			Math.max(0, box[1]),
			Math.min(w, box[2]),
			Math.min(h, box[3]),
		];
		if (box[2] - box[0] < 8 || box[3] - box[1] < 8) continue;
		const kind: FigureKind =
			f.kind === "table" ? "table" : f.image ? "image" : "vector";
		out.push({
			page: input.page,
			rect: toRect(box),
			kind,
			...(f.caption
				? {
						label: f.caption.label,
						caption: { text: f.caption.text, rect: toRect(f.caption.box) },
					}
				: {}),
		});
	}
	// Absorbed text can make two figures overlap; the smaller one goes.
	const kept = out.filter(
		(f, i) =>
			!out.some(
				(g, j) =>
					j !== i &&
					area(boxOf(g.rect)) > area(boxOf(f.rect)) &&
					inside(boxOf(f.rect), boxOf(g.rect)) > 0.8,
			),
	);
	return kept.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

const boxOf = (r: Rect): Box => [r.x, r.y, r.x + r.w, r.y + r.h];

/** The figure whose rect contains the point (page points), smallest first. */
export function figureAt(
	figures: readonly PageFigure[],
	x: number,
	y: number,
): PageFigure | null {
	let best: PageFigure | null = null;
	for (const f of figures) {
		const r = f.rect;
		if (x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) continue;
		if (!best || r.w * r.h < best.rect.w * best.rect.h) best = f;
	}
	return best;
}

/** Page text as lines from per-char codes and boxes (l, t, r, b; all zero for generated chars). */
export function linesFromChars(
	codes: ArrayLike<number>,
	boxes: ArrayLike<number>,
): FigureLine[] {
	const lines: FigureLine[] = [];
	let text = "";
	let box: Box | null = null;
	const flush = () => {
		if (box && text.trim())
			lines.push({ text: text.replace(/\s+/g, " ").trim(), box });
		text = "";
		box = null;
	};
	for (let i = 0; i < codes.length; i++) {
		const code = codes[i]!;
		if (code === 10 || code === 13) {
			flush();
			continue;
		}
		const l = boxes[i * 4]!;
		const t = boxes[i * 4 + 1]!;
		const r = boxes[i * 4 + 2]!;
		const b = boxes[i * 4 + 3]!;
		const ch = String.fromCodePoint(code);
		if (r - l <= 0 && b - t <= 0) {
			if (box) text += ch;
			continue;
		}
		if (box) {
			const lh = box[3] - box[1];
			const sameLine =
				overlapY(box, [l, t, r, b]) > 0.4 * Math.min(lh, b - t) &&
				l > box[0] - lh &&
				l - box[2] < lh * 4;
			if (!sameLine) flush();
		}
		box = box ? union(box, [l, t, r, b]) : [l, t, r, b];
		text += ch;
	}
	flush();
	return lines;
}

// ---------------------------------------------------------------- raster-worker side

export interface FigureContext {
	P: Pdfium;
	heap(): Uint8Array;
	/** PDF user space -> page points (top-left origin, as displayed) */
	toPage(x: number, y: number): [number, number];
}

const FPDF_PAGEOBJ_PATH = 2;
const FPDF_PAGEOBJ_IMAGE = 3;
const FPDF_PAGEOBJ_SHADING = 4;
const FPDF_PAGEOBJ_FORM = 5;
/** a page with more objects than this is read up to it (a dense plot is still one figure) */
const MAX_OBJECTS = 60000;

type Matrix = [number, number, number, number, number, number];

const concat = (m: Matrix, n: Matrix): Matrix => [
	n[0] * m[0] + n[2] * m[1],
	n[1] * m[0] + n[3] * m[1],
	n[0] * m[2] + n[2] * m[3],
	n[1] * m[2] + n[3] * m[3],
	n[0] * m[4] + n[2] * m[5] + n[4],
	n[1] * m[4] + n[3] * m[5] + n[5],
];

/** Image and path boxes on the page in page points, walking into form XObjects. */
export function readFigureObjects(
	ctx: FigureContext,
	page: number,
): { images: Box[]; paths: Box[] } {
	const { P } = ctx;
	const images: Box[] = [];
	const paths: Box[] = [];
	let seen = 0;
	const mem = P.pdfium.wasmExports.malloc(24);
	const f32 = () => new Float32Array(ctx.heap().buffer, mem, 6);
	const walk = (count: number, get: (i: number) => number, m: Matrix) => {
		for (let i = 0; i < count && seen < MAX_OBJECTS; i++) {
			seen++;
			const obj = get(i);
			const type = P.FPDFPageObj_GetType(obj);
			if (type === FPDF_PAGEOBJ_FORM) {
				if (!P.FPDFPageObj_GetMatrix(obj, mem)) continue;
				const f = f32();
				walk(
					P.FPDFFormObj_CountObjects(obj),
					(j) => P.FPDFFormObj_GetObject(obj, j),
					concat([f[0]!, f[1]!, f[2]!, f[3]!, f[4]!, f[5]!], m),
				);
				continue;
			}
			if (
				type !== FPDF_PAGEOBJ_PATH &&
				type !== FPDF_PAGEOBJ_IMAGE &&
				type !== FPDF_PAGEOBJ_SHADING
			)
				continue;
			if (!P.FPDFPageObj_GetBounds(obj, mem, mem + 4, mem + 8, mem + 12))
				continue;
			const [l, b, r, t] = f32();
			let x0 = Infinity;
			let y0 = Infinity;
			let x1 = -Infinity;
			let y1 = -Infinity;
			for (const [cx, cy] of [
				[l!, b!],
				[r!, b!],
				[l!, t!],
				[r!, t!],
			] as const) {
				const [px, py] = ctx.toPage(
					m[0] * cx + m[2] * cy + m[4],
					m[1] * cx + m[3] * cy + m[5],
				);
				x0 = Math.min(x0, px);
				y0 = Math.min(y0, py);
				x1 = Math.max(x1, px);
				y1 = Math.max(y1, py);
			}
			if (!Number.isFinite(x0 + y0 + x1 + y1)) continue;
			(type === FPDF_PAGEOBJ_IMAGE ? images : paths).push([x0, y0, x1, y1]);
		}
	};
	try {
		walk(
			P.FPDFPage_CountObjects(page),
			(i) => P.FPDFPage_GetObject(page, i),
			[1, 0, 0, 1, 0, 0],
		);
	} finally {
		P.pdfium.wasmExports.free(mem);
	}
	return { images, paths };
}

/** Text lines from PDFium's text page, in page points. */
export function readFigureLines(
	ctx: FigureContext,
	page: number,
): FigureLine[] {
	const { P } = ctx;
	const tp = P.FPDFText_LoadPage(page);
	if (!tp) return [];
	const rect = P.pdfium.wasmExports.malloc(16);
	try {
		const n = Math.max(0, P.FPDFText_CountChars(tp));
		const codes = new Uint32Array(n);
		const boxes = new Float32Array(n * 4);
		for (let i = 0; i < n; i++) {
			codes[i] = P.FPDFText_GetUnicode(tp, i);
			if (
				P.FPDFText_IsGenerated(tp, i) ||
				!P.FPDFText_GetLooseCharBox(tp, i, rect)
			)
				continue;
			const [l, t, r, b] = new Float32Array(ctx.heap().buffer, rect, 4);
			const [ax, ay] = ctx.toPage(l!, t!);
			const [bx, by] = ctx.toPage(r!, b!);
			boxes.set(
				[
					Math.min(ax, bx),
					Math.min(ay, by),
					Math.max(ax, bx),
					Math.max(ay, by),
				],
				i * 4,
			);
		}
		return linesFromChars(codes, boxes);
	} finally {
		P.pdfium.wasmExports.free(rect);
		P.FPDFText_ClosePage(tp);
	}
}
