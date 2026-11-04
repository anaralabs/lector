// ?edit=1: a bare editing toolbar over the demo viewer (prototype; not a product UI).
import type { CoreEvent, EditOutcome, PageObject, Rect, Viewer } from "../src";

type Line = { page: number; objs: PageObject[]; box: [number, number, number, number] };

const w = window as unknown as { __viewer?: Viewer; __editEvent?: (e: CoreEvent) => void; __editLog: unknown[] };
w.__editLog = [];
const bar = document.getElementById("bar")!;
const hud = document.getElementById("hud")!;
let layout: Rect[] = [];
let page = 0;
let mode: "select" | "add" = "select";
let selected: Line | null = null;
const objects = new Map<number, Promise<PageObject[]>>();
let status = "";
let input: HTMLInputElement | null = null;

const button = (label: string, run: () => void) => {
	const b = document.createElement("button");
	b.textContent = label;
	b.onclick = run;
	bar.appendChild(b);
	return b;
};
const viewer = () => w.__viewer!;
const say = (s: string) => {
	status = s;
	hud.dataset.edit = s;
};

const objs = (p: number) => {
	const hit = objects.get(p) ?? viewer().pageObjects(p);
	objects.set(p, hit);
	return hit;
};

const inside = (b: PageObject["box"], x: number, y: number, pad = 1) => x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad;

/** The visual line under a point: text objects on one baseline with the same font, chained by small gaps. */
function lineAt(list: PageObject[], p: number, x: number, y: number): Line | null {
	const texts = list.filter((o) => o.type === "text");
	const hit = texts.find((o) => inside(o.box, x, y)) ?? null;
	if (!hit) {
		const other = list.filter((o) => o.type !== "text" && inside(o.box, x, y, 0)).sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0];
		return other ? { page: p, objs: [other], box: other.box } : null;
	}
	const h = hit.box[3] - hit.box[1];
	const same = texts
		.filter((o) => o.font === hit.font && Math.abs((o.size ?? 0) - (hit.size ?? 0)) < 0.1)
		.filter((o) => Math.min(o.box[3], hit.box[3]) - Math.max(o.box[1], hit.box[1]) > 0.5 * Math.min(h, o.box[3] - o.box[1]))
		.sort((a, b) => a.box[0] - b.box[0]);
	const gap = (hit.size ?? h) * 0.8;
	let lo = same.indexOf(hit);
	let hi = lo;
	while (lo > 0 && same[lo]!.box[0] - same[lo - 1]!.box[2] < gap) lo--;
	while (hi < same.length - 1 && same[hi + 1]!.box[0] - same[hi]!.box[2] < gap) hi++;
	const run = same.slice(lo, hi + 1);
	const box: Line["box"] = [Math.min(...run.map((o) => o.box[0])), Math.min(...run.map((o) => o.box[1])), Math.max(...run.map((o) => o.box[2])), Math.max(...run.map((o) => o.box[3]))];
	return { page: p, objs: run, box };
}

function show(line: Line | null) {
	selected = line;
	viewer().setHighlights(line ? [{ id: "edit-sel", page: line.page, rects: [{ x: line.box[0], y: line.box[1], w: line.box[2] - line.box[0], h: line.box[3] - line.box[1] }], style: "outline", color: [0.2, 0.45, 1, 1], interactive: false }] : []);
}

function screen(p: number, x: number, y: number) {
	const cam = viewer().camera;
	const r = layout[p]!;
	return { x: (r.x + x - cam.x) * cam.zoom, y: (r.y + y - cam.y) * cam.zoom, z: cam.zoom };
}

function prompt(p: number, x: number, y: number, h: number, value: string, done: (text: string) => void) {
	input?.remove();
	const s = screen(p, x, y);
	const el = document.createElement("input");
	el.value = value;
	el.style.cssText = `position:absolute;left:${s.x}px;top:${s.y}px;min-width:${Math.max(120, value.length * h * s.z * 0.5)}px;height:${Math.max(18, h * s.z)}px;font:${Math.max(10, h * s.z * 0.8)}px serif;pointer-events:auto;border:1px solid #3a6df0;background:#fff;padding:0 2px;`;
	el.onkeydown = (e) => {
		e.stopPropagation();
		if (e.key === "Enter") {
			el.remove();
			input = null;
			done(el.value);
		} else if (e.key === "Escape") {
			el.remove();
			input = null;
		}
	};
	viewer().overlayElement.appendChild(el);
	input = el;
	el.focus();
	el.select();
}

async function run(what: string, op: () => Promise<EditOutcome | null>) {
	try {
		const t0 = performance.now();
		const out = await op();
		const ms = performance.now() - t0;
		objects.clear();
		show(null);
		const fb = out?.font && out.font !== "same" ? `  fallback ${out.font}` : out?.font === "same" ? "  same font" : "";
		const wd = out?.widthDelta ? `  width ${out.widthDelta > 0 ? "+" : ""}${out.widthDelta.toFixed(1)}pt` : "";
		say(`${what}: ${ms.toFixed(1)}ms round trip (worker ${out?.ms?.toFixed(1) ?? "-"}ms)${fb}${wd}`);
		w.__editLog.push({ what, ms, out });
	} catch (e) {
		say(`${what} failed: ${(e as Error).message}`);
	}
}

const edit = (what: string, op: Parameters<Viewer["edit"]>[0]) => run(what, () => viewer().edit(op));

async function click(p: number, x: number, y: number) {
	if (mode === "add") {
		mode = "select";
		addBtn.textContent = "text +";
		prompt(p, x, y - 12, 14, "New text", (text) => void edit("add text", { kind: "add-text", page: p, x, y: y + 2, text, size: 12 }));
		return;
	}
	const line = lineAt(await objs(p), p, x, y);
	show(line);
	if (!line) return;
	const first = line.objs[0]!;
	if (first.type !== "text") {
		say(`${first.type} object #${first.index} selected (Delete removes it)`);
		return;
	}
	const text = line.objs.map((o) => o.text ?? "").join(line.objs.length > 1 && line.objs.every((o) => (o.text?.length ?? 0) > 2) ? " " : "");
	say(`${line.objs.length} text object(s), ${first.font}${first.embedded ? "" : " (not embedded)"} ${first.size?.toFixed(1)}pt${first.invisible ? " (invisible OCR text)" : ""}`);
	prompt(p, line.box[0], line.box[1], line.box[3] - line.box[1], text, (next) => {
		if (next === text) return;
		void edit("edit text", { kind: "set-text", page: p, obj: first.index, text: next, absorb: line.objs.slice(1).map((o) => o.index) });
	});
}

async function remove() {
	const line = selected;
	if (!line) return;
	await run("delete", async () => {
		let out: EditOutcome | null = null;
		for (const o of [...line.objs].sort((a, b) => b.index - a.index)) out = await viewer().edit({ kind: "delete-object", page: line.page, obj: o.index });
		return out;
	});
}

const addBtn = button("text +", () => {
	mode = mode === "add" ? "select" : "add";
	addBtn.textContent = mode === "add" ? "click to place" : "text +";
});
button("delete", () => void remove());
button("redact", () => {
	if (selected) void edit("redact", { kind: "redact", page: selected.page, rect: selected.box });
});
button("rotate page", () => void edit("rotate", { kind: "rotate-page", page, quarter: 1 }));
button("delete page", () => void edit("delete page", { kind: "delete-page", page }));
button("undo", () => void run("undo", () => viewer().undo()));
button("redo", () => void run("redo", () => viewer().redo()));
button("save", async () => {
	const t0 = performance.now();
	const bytes = await viewer().saveDocument();
	say(`saved ${(bytes.length / 1024).toFixed(0)}KB in ${(performance.now() - t0).toFixed(0)}ms`);
	const a = document.createElement("a");
	a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
	a.download = "edited.pdf";
	a.click();
});

window.addEventListener("keydown", (e) => {
	if (input) return;
	const mod = e.metaKey || e.ctrlKey;
	if (mod && e.key.toLowerCase() === "z") {
		e.preventDefault();
		void run(e.shiftKey ? "redo" : "undo", () => (e.shiftKey ? viewer().redo() : viewer().undo()));
	} else if (e.key === "Backspace" || e.key === "Delete") void remove();
});

w.__editEvent = (e) => {
	if (e.type === "ready" || e.type === "layout") layout = e.layout;
	else if (e.type === "view") page = e.page;
	else if (e.type === "click") void click(e.page, e.x, e.y);
	else if (e.type === "edited") objects.clear();
	else if (e.type === "edit-painted") {
		w.__editLog.push({ painted: e.page, ms: e.ms });
		say(`${status.split("  repaint")[0]}  repaint ${e.ms.toFixed(0)}ms`);
	}
};
