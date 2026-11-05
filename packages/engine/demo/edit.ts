// ?edit=1: in-place content editing over the demo viewer (prototype; not a product UI).
import "./edit.css";
import type {
	Camera,
	CoreEvent,
	EditOp,
	EditOutcome,
	PageObject,
	Rect,
	Viewer,
} from "../src";

type Box = [number, number, number, number];
type Line = { page: number; objs: PageObject[]; box: Box };
type Face = { family: string; weight: number; italic: boolean };
type Editing = {
	page: number;
	line: Line | null;
	text: string;
	x: number;
	baseline: number;
	size: number;
	face: Face;
	color: string;
	scale: number;
	committing: boolean;
};

const w = window as unknown as {
	__viewer?: Viewer;
	__editEvent?: (e: CoreEvent) => void;
	__editLog: unknown[];
};
w.__editLog = [];
const params = new URLSearchParams(location.search);
if (params.get("dark") === "1") document.documentElement.dataset.theme = "dark";
document.body.classList.add("edit-ui");
if (params.get("hud") === "1") document.body.classList.add("hud-on");

const viewerEl = document.getElementById("viewer")!;
const hud = document.getElementById("hud")!;
const viewer = () => w.__viewer!;

const div = (cls: string, parent: HTMLElement) => {
	const d = document.createElement("div");
	d.className = cls;
	parent.appendChild(d);
	return d;
};
const layer = div("ed-layer", document.body);
const hoverEl = div("ed-hover", layer);
const selEl = div("ed-sel", layer);
const maskEl = div("ed-mask", layer);
const frameEl = div("ed-frame", layer);
const ghostEl = div("ed-ghost", layer);
const input = document.createElement("input");
input.className = "ed-input";
input.spellcheck = false;
input.autocomplete = "off";
layer.appendChild(input);
const ctxEl = div("ed-ctx", layer);
const noteEl = div("ed-note", layer);
const statusEl = div("ed-status", document.body);
const tipEl = div("ed-tip", document.body);

let layout: Rect[] = [];
let cam: Camera = { x: 0, y: 0, zoom: 1 };
let page = 0;
let adding = false;
let hover: Line | null = null;
let sel: Line | null = null;
let ed: Editing | null = null;
let note: { page: number; box: Box; timer: number } | null = null;
let pointer: { page: number; x: number; y: number } | null = null;
let undoable = 0;
let redoable = 0;
let busy: Promise<unknown> = Promise.resolve();
const objects = new Map<number, Promise<PageObject[]>>();
const painted = new Map<number, () => void>();

const SERIF = `"Times New Roman", "Nimbus Roman", Times, serif`;
const SANS = `Helvetica, Arial, "Nimbus Sans", sans-serif`;
const MONO = `"Courier New", Courier, "Nimbus Mono PS", monospace`;
const ADD_SIZE = 12;

function faceOf(font = "", flags = 0): Face {
	const n = font.replace(/^[A-Z]{6}\+/, "");
	const mono = flags & 1 || /mono|courier|cmtt|sftt|consol|menlo|code/i.test(n);
	const named =
		/sans|helv|arial|cmss|sfss|gothic|grotesk|inter|roboto|verdana|calibri|segoe|futura|avenir|frutiger|myriad|lato/i.test(
			n,
		);
	// flag 2 = serif, 32 = nonsymbolic (TeX subsets are symbolic and carry no serif bit)
	const sans =
		!mono &&
		(named ||
			(!(flags & 2) &&
				!!(flags & 32) &&
				!/times|roman|serif|georgia|garamond|nimbusrom|cmr/i.test(n)));
	return {
		family: mono ? MONO : sans ? SANS : SERIF,
		weight:
			flags & (1 << 18) ||
			/bold|black|heavy|semibold|demi|medi|cmbx|sfbx/i.test(n)
				? 700
				: 400,
		italic:
			!!(flags & 64) || /italic|oblique|cmti|sfti|cmmi|[-,]it\b|ital/i.test(n),
	};
}

const dark = document.documentElement.dataset.theme === "dark";
/** The object's own colour; near-black follows the theme's ink (dark mode re-tones it). */
const inkOf = (c?: [number, number, number]) => {
	if (!c || (dark && Math.max(...c) < 60)) return "";
	return dark
		? `color-mix(in srgb, rgb(${c.join(",")}) 72%, white)`
		: `rgb(${c.join(",")})`;
};

const ctx2d = document.createElement("canvas").getContext("2d")!;
const cssFont = (f: Face, px: number) =>
	`${f.italic ? "italic " : ""}${f.weight} ${px}px ${f.family}`;
function measure(f: Face, px: number, text: string) {
	ctx2d.font = cssFont(f, px);
	const m = ctx2d.measureText(text || "Hg");
	return {
		width: text ? m.width : 0,
		ascent: m.fontBoundingBoxAscent,
		descent: m.fontBoundingBoxDescent,
	};
}

const objs = (p: number) => {
	const hit = objects.get(p) ?? viewer().pageObjects(p);
	objects.set(p, hit);
	return hit;
};

const inside = (b: Box, x: number, y: number, pad = 1) =>
	x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad;
const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);

/** The visual line under a point: text objects on one baseline with the same font, chained by small gaps. */
function lineAt(
	list: PageObject[],
	p: number,
	x: number,
	y: number,
): Line | null {
	const texts = list.filter((o) => o.type === "text");
	const hit = texts.find((o) => inside(o.box, x, y)) ?? null;
	if (!hit) {
		const r = layout[p];
		const cap = r ? r.w * r.h * 0.5 : Infinity;
		const other = list
			.filter(
				(o) => o.type !== "text" && inside(o.box, x, y, 2) && area(o.box) < cap,
			)
			.sort((a, b) => area(a.box) - area(b.box))[0];
		return other ? { page: p, objs: [other], box: other.box } : null;
	}
	const h = hit.box[3] - hit.box[1];
	const same = texts
		.filter(
			(o) =>
				o.font === hit.font && Math.abs((o.size ?? 0) - (hit.size ?? 0)) < 0.1,
		)
		.filter(
			(o) =>
				Math.min(o.box[3], hit.box[3]) - Math.max(o.box[1], hit.box[1]) >
				0.5 * Math.min(h, o.box[3] - o.box[1]),
		)
		.sort((a, b) => a.box[0] - b.box[0]);
	const gap = (hit.size ?? h) * 0.8;
	let lo = same.indexOf(hit);
	let hi = lo;
	while (lo > 0 && same[lo]!.box[0] - same[lo - 1]!.box[2] < gap) lo--;
	while (hi < same.length - 1 && same[hi + 1]!.box[0] - same[hi]!.box[2] < gap)
		hi++;
	const run = same.slice(lo, hi + 1);
	const box: Box = [
		Math.min(...run.map((o) => o.box[0])),
		Math.min(...run.map((o) => o.box[1])),
		Math.max(...run.map((o) => o.box[2])),
		Math.max(...run.map((o) => o.box[3])),
	];
	return { page: p, objs: run, box };
}

const isText = (l: Line | null) => l?.objs[0]!.type === "text";
const lineText = (l: Line) =>
	l.objs
		.map((o) => o.text ?? "")
		.join(
			l.objs.length > 1 && l.objs.every((o) => (o.text?.length ?? 0) > 2)
				? " "
				: "",
		);
const sameLine = (a: Line | null, b: Line | null) =>
	!!a && !!b && a.page === b.page && a.objs[0]!.index === b.objs[0]!.index;
/** Baseline from a tight glyph box: drop the descent only when the text has descenders. */
const baselineOf = (l: Line, size: number) =>
	l.box[3] - (/[gjpqyQ,;()[\]{}|/_@$]/.test(lineText(l)) ? 0.21 * size : 0);

const sx = (p: number, x: number) => (layout[p]!.x + x - cam.x) * cam.zoom;
const sy = (p: number, y: number) => (layout[p]!.y + y - cam.y) * cam.zoom;
function place(el: HTMLElement, p: number, b: Box, pad = 0) {
	if (!layout[p]) return false;
	el.style.transform = `translate(${sx(p, b[0]) - pad}px, ${sy(p, b[1]) - pad}px)`;
	el.style.width = `${(b[2] - b[0]) * cam.zoom + pad * 2}px`;
	el.style.height = `${(b[3] - b[1]) * cam.zoom + pad * 2}px`;
	return true;
}
const show = (el: HTMLElement, on: boolean, display = "block") => {
	el.style.display = on ? display : "none";
};

function toPage(clientX: number, clientY: number) {
	if (w.__viewer) cam = w.__viewer.camera;
	const r = viewerEl.getBoundingClientRect();
	const dx = cam.x + (clientX - r.left) / cam.zoom;
	const dy = cam.y + (clientY - r.top) / cam.zoom;
	const p = layout.findIndex(
		(l) => dx >= l.x && dx <= l.x + l.w && dy >= l.y && dy <= l.y + l.h,
	);
	return p < 0 ? null : { page: p, x: dx - layout[p]!.x, y: dy - layout[p]!.y };
}

function render() {
	if (w.__viewer) cam = w.__viewer.camera;
	const hv =
		hover &&
		!adding &&
		!sameLine(hover, sel) &&
		!(ed && sameLine(hover, ed.line));
	show(hoverEl, !!hv && place(hoverEl, hover!.page, hover!.box, 2));
	hoverEl.classList.toggle("obj", !!hover && !isText(hover));
	show(selEl, !!sel && place(selEl, sel.page, sel.box, 2));
	renderCtx();
	renderEditor();
	if (note && layout[note.page])
		noteEl.style.transform = `translate(${Math.max(8, sx(note.page, note.box[0]) - 2)}px, ${sy(note.page, note.box[3]) + 8}px)`;
	const g = adding && pointer && !ed;
	show(ghostEl, !!g);
	if (g) {
		ghostEl.style.height = `${ADD_SIZE * cam.zoom}px`;
		ghostEl.style.transform = `translate(${sx(pointer!.page, pointer!.x)}px, ${sy(pointer!.page, pointer!.y + ADD_SIZE * 0.35 - ADD_SIZE * 0.8)}px)`;
	}
}
let queued = false;
const schedule = () => {
	if (queued) return;
	queued = true;
	requestAnimationFrame(() => {
		queued = false;
		render();
	});
};

function renderCtx() {
	if (!sel || !layout[sel.page]) return show(ctxEl, false);
	ctxEdit.style.display = ctxSep.style.display = isText(sel) ? "" : "none";
	show(ctxEl, true, "flex");
	const top = sy(sel.page, sel.box[1]) - 44;
	const y = top < 60 ? sy(sel.page, sel.box[3]) + 8 : top;
	const x = Math.min(
		Math.max(8, sx(sel.page, sel.box[0]) - 2),
		innerWidth - ctxEl.offsetWidth - 8,
	);
	ctxEl.style.transform = `translate(${x}px, ${y}px)`;
}

function renderEditor() {
	const on = !!ed && !!layout[ed.page];
	show(input, on);
	show(frameEl, on && !ed!.committing);
	show(maskEl, on && !!ed!.line && !ed!.line.objs[0]!.invisible);
	if (!on) return;
	const e = ed!;
	const px = e.size * cam.zoom;
	const m = measure(e.face, px, input.value);
	const h = m.ascent + m.descent;
	const left = sx(e.page, e.x);
	const top = sy(e.page, e.baseline) - m.ascent;
	const width = Math.max(m.width + 2, 2);
	input.style.font = cssFont(e.face, px);
	input.style.color = e.color;
	input.style.lineHeight = `${h}px`;
	input.style.height = `${h}px`;
	input.style.width = `${width}px`;
	input.style.transform = `translate(${left}px, ${top}px) scaleX(${e.scale})`;
	let u: Box = [left, top, left + width * e.scale, top + h];
	if (e.line && place(maskEl, e.page, e.line.box, 2)) {
		const b = e.line.box;
		u = [
			Math.min(u[0], sx(e.page, b[0])),
			Math.min(u[1], sy(e.page, b[1])),
			Math.max(u[2], sx(e.page, b[2])),
			Math.max(u[3], sy(e.page, b[3])),
		];
	}
	frameEl.style.transform = `translate(${u[0] - 3}px, ${u[1] - 3}px)`;
	frameEl.style.width = `${u[2] - u[0] + 6}px`;
	frameEl.style.height = `${u[3] - u[1] + 6}px`;
}

function setStatus(text: string) {
	statusEl.textContent = text;
	statusEl.classList.add("show");
	hud.dataset.edit = text;
}

function showNote(p: number, box: Box, lines: string[], refused = false) {
	clearNote();
	if (!lines.length) return;
	noteEl.replaceChildren(
		...lines.map((t) => {
			const d = document.createElement("div");
			d.innerHTML = `<span>${t}</span>`;
			return d;
		}),
	);
	noteEl.classList.toggle("refused", refused);
	show(noteEl, true);
	note = { page: p, box, timer: window.setTimeout(clearNote, 8000) };
	render();
	requestAnimationFrame(() => noteEl.classList.add("show"));
}
function clearNote() {
	if (!note) return;
	clearTimeout(note.timer);
	note = null;
	noteEl.classList.remove("show");
	show(noteEl, false);
}

const reason = (e: unknown) =>
	String((e as Error)?.message ?? e)
		.replace(/^(Error:\s*)+/, "")
		.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Runs edits one at a time; resolves the outcome or throws the engine's refusal. */
function run<T extends EditOutcome | null>(
	label: string,
	op: () => Promise<T>,
	kind: "edit" | "undo" | "redo" = "edit",
): Promise<T> {
	const next = busy.then(async () => {
		const t0 = performance.now();
		const out = await op();
		const ms = performance.now() - t0;
		objects.clear();
		if (kind === "edit") [undoable, redoable] = [undoable + 1, 0];
		else if (kind === "undo")
			[undoable, redoable] = out
				? [Math.max(0, undoable - 1), redoable + 1]
				: [0, redoable];
		else
			[undoable, redoable] = out
				? [undoable + 1, Math.max(0, redoable - 1)]
				: [undoable, 0];
		syncHistory();
		setStatus(
			out || kind === "edit"
				? `${label} · ${ms.toFixed(0)} ms`
				: `Nothing to ${kind}`,
		);
		w.__editLog.push({ what: label, ms, out });
		return out;
	});
	busy = next.catch(() => {});
	return next;
}

const waitPainted = (p: number) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(done, 600);
		function done() {
			clearTimeout(t);
			painted.delete(p);
			resolve();
		}
		painted.set(p, done);
	});

function openEditor(e: Omit<Editing, "scale" | "committing">, caretX?: number) {
	clearNote();
	sel = null;
	cam = viewer().camera;
	const px = e.size * cam.zoom;
	let scale = 1;
	if (e.line) {
		const natural = measure(e.face, px, e.text).width;
		const ratio = natural
			? ((e.line.box[2] - e.line.box[0]) * cam.zoom) / natural
			: 1;
		if (ratio > 0.8 && ratio < 1.25) scale = ratio;
	}
	ed = { ...e, scale, committing: false };
	input.value = e.text;
	input.placeholder = e.line ? "" : "Type text";
	input.readOnly = false;
	input.classList.toggle("ghostly", !!e.line?.objs[0]!.invisible);
	render();
	input.focus({ preventScroll: true });
	if (caretX === undefined) return input.select();
	const off = ((caretX - e.x) * cam.zoom) / scale;
	let best = 0;
	for (let i = 0, d = Infinity; i <= e.text.length; i++) {
		const di = Math.abs(measure(e.face, px, e.text.slice(0, i)).width - off);
		if (di < d) [d, best] = [di, i];
	}
	input.setSelectionRange(best, best);
}

function closeEditor() {
	ed = null;
	input.blur();
	render();
	viewerEl.focus({ preventScroll: true });
}

async function commit() {
	const e = ed;
	if (!e || e.committing) return;
	const text = input.value;
	if (e.line ? text === e.text : !text.trim()) return closeEditor();
	e.committing = true;
	input.readOnly = true;
	render();
	const line = e.line;
	const near: Box = line?.box ?? [
		e.x,
		e.baseline - ADD_SIZE,
		e.x,
		e.baseline + 2,
	];
	try {
		let out: EditOutcome;
		if (!line)
			out = await run("Added text", () =>
				viewer().edit({
					kind: "add-text",
					page: e.page,
					x: e.x,
					y: e.baseline,
					text,
					size: ADD_SIZE,
				}),
			);
		else if (!text.trim()) out = await deleteObjs(line);
		else
			out = await run("Edited text", () =>
				viewer().edit({
					kind: "set-text",
					page: e.page,
					obj: line.objs[0]!.index,
					text,
					absorb: line.objs.slice(1).map((o) => o.index),
				}),
			);
		await waitPainted(e.page);
		if (ed === e) closeEditor();
		const lines: string[] = [];
		if (line && out.font && out.font !== "same")
			lines.push(
				`Set in <b>${out.font}</b> — the original font lacks these glyphs`,
			);
		if ((out.widthDelta ?? 0) > 1)
			lines.push(
				`Line is ${out.widthDelta!.toFixed(0)} pt wider than the original; text doesn't reflow yet`,
			);
		showNote(e.page, near, lines);
	} catch (err) {
		if (ed === e) closeEditor();
		setStatus("Edit refused");
		showNote(e.page, near, [`Couldn't apply — ${reason(err)}`], true);
	}
}

function cancelEditor() {
	const line = ed?.line ?? null;
	closeEditor();
	sel = line;
	render();
}

async function deleteObjs(line: Line) {
	let out: EditOutcome | null = null;
	await run(
		isText(line) ? "Deleted line" : `Deleted ${line.objs[0]!.type}`,
		async () => {
			for (const o of [...line.objs].sort((a, b) => b.index - a.index))
				out = await viewer().edit({
					kind: "delete-object",
					page: line.page,
					obj: o.index,
				});
			return out;
		},
	);
	return out!;
}

async function act(what: "delete" | "redact" | "edit") {
	const line = sel;
	if (!line) return;
	if (what === "edit") return editLine(line);
	sel = null;
	clearNote();
	render();
	try {
		if (what === "delete") await deleteObjs(line);
		else
			await run("Redacted", () =>
				viewer().edit({ kind: "redact", page: line.page, rect: line.box }),
			);
	} catch (err) {
		showNote(line.page, line.box, [`Couldn't apply — ${reason(err)}`], true);
	}
}

function editLine(line: Line, caretX?: number) {
	const first = line.objs[0]!;
	const size = first.size ?? line.box[3] - line.box[1];
	openEditor(
		{
			page: line.page,
			line,
			text: lineText(line),
			x: line.box[0],
			baseline: baselineOf(line, size),
			size,
			face: faceOf(first.font, first.flags),
			color: inkOf(first.color),
		},
		caretX,
	);
}

async function click(p: number, x: number, y: number) {
	if (ed) return;
	await busy;
	if (adding) {
		setAdding(false);
		return openEditor({
			page: p,
			line: null,
			text: "",
			x,
			baseline: y + ADD_SIZE * 0.35,
			size: ADD_SIZE,
			face: faceOf("Helvetica"),
			color: "",
		});
	}
	clearNote();
	const line = lineAt(await objs(p), p, x, y);
	if (line && isText(line)) return editLine(line, x);
	sel = line;
	render();
}

async function pageEdit(label: string, op: EditOp) {
	if (ed) await commit();
	sel = null;
	clearNote();
	render();
	try {
		await run(label, () => viewer().edit(op));
	} catch (err) {
		setStatus(`${label} failed — ${reason(err)}`);
	}
}

function history(kind: "undo" | "redo") {
	if (ed) return;
	sel = null;
	clearNote();
	render();
	void run(
		kind === "undo" ? "Undid edit" : "Redid edit",
		() => viewer()[kind](),
		kind,
	).catch((err) => setStatus(`${kind} failed — ${reason(err)}`));
}

async function save() {
	if (ed) await commit();
	await busy;
	const t0 = performance.now();
	const bytes = await viewer().saveDocument();
	setStatus(
		`Saved ${(bytes.length / 1048576).toFixed(1)} MB · ${(performance.now() - t0).toFixed(0)} ms`,
	);
	const a = document.createElement("a");
	a.href = URL.createObjectURL(
		new Blob([bytes as BlobPart], { type: "application/pdf" }),
	);
	a.download = "edited.pdf";
	a.click();
}

function setAdding(on: boolean) {
	adding = on;
	addBtn.classList.toggle("on", on);
	if (on) {
		sel = null;
		clearNote();
	}
	updateCursor();
	render();
}

function updateCursor() {
	viewerEl.classList.toggle("ed-cur-add", adding);
	viewerEl.classList.toggle("ed-cur-text", !adding && isText(hover));
	viewerEl.classList.toggle("ed-cur-obj", !adding && !!hover && !isText(hover));
}

const ICONS: Record<string, string> = {
	text: '<path d="M4 4.5h8M8 4.5v8"/>',
	rotate:
		'<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2"/><path d="M11.6 2.2v2.8H8.8"/>',
	page: '<path d="M4.5 2.5h5l2.5 2.5v8.5h-7.5z"/><path d="M6.5 9.5h3.5"/>',
	undo: '<path d="M5 6.5h5a3 3 0 0 1 0 6H7.5"/><path d="M7 4 4.5 6.5 7 9"/>',
	redo: '<path d="M11 6.5H6a3 3 0 0 0 0 6h2.5"/><path d="M9 4l2.5 2.5L9 9"/>',
	save: '<path d="M8 2.5v8M5 7.5l3 3 3-3"/><path d="M3.5 13.5h9"/>',
	info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3"/><path d="M8 5.25v.01"/>',
	trash: '<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5"/>',
	redact: '<rect x="2.5" y="5.5" width="11" height="5" rx="0.5"/>',
	edit: '<path d="M10.5 3l2.5 2.5-7 7H3.5V10z"/>',
};
const svg = (name: string) =>
	`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

let tipTimer = 0;
let tipWarm = 0;
function tip(b: HTMLElement, label: string, key?: string) {
	b.setAttribute("aria-label", label);
	b.addEventListener("mouseenter", () => {
		clearTimeout(tipTimer);
		const reveal = () => {
			tipEl.innerHTML = `<span>${label}</span>${key ? `<kbd>${key}</kbd>` : ""}`;
			const r = b.getBoundingClientRect();
			const below = r.top < 80;
			tipEl.style.left = `${Math.round(Math.min(innerWidth - tipEl.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tipEl.offsetWidth / 2)))}px`;
			tipEl.style.top = `${Math.round(below ? r.bottom + 8 : r.top - tipEl.offsetHeight - 8)}px`;
			tipEl.classList.add("show");
		};
		tipTimer = window.setTimeout(reveal, Date.now() - tipWarm < 400 ? 0 : 450);
	});
	const hide = () => {
		clearTimeout(tipTimer);
		if (tipEl.classList.contains("show")) tipWarm = Date.now();
		tipEl.classList.remove("show");
	};
	b.addEventListener("mouseleave", hide);
	b.addEventListener("click", hide);
}

function button(
	parent: HTMLElement,
	icon: string,
	label: string,
	onClick: () => void,
	key?: string,
	text?: string,
) {
	const b = document.createElement("button");
	b.innerHTML = svg(icon) + (text ? `<span>${text}</span>` : "");
	b.onmousedown = (e) => e.preventDefault();
	b.onclick = onClick;
	tip(b, label, key);
	parent.appendChild(b);
	return b;
}

const tb = div("ed-tb", document.body);
const addBtn = button(tb, "text", "Add text", () => setAdding(!adding), "T");
div("sep", tb);
button(
	tb,
	"rotate",
	"Rotate page",
	() =>
		void pageEdit("Rotated page", { kind: "rotate-page", page, quarter: 1 }),
);
button(
	tb,
	"page",
	"Delete page",
	() => void pageEdit("Deleted page", { kind: "delete-page", page }),
);
div("sep", tb);
const undoBtn = button(tb, "undo", "Undo", () => history("undo"), "⌘Z");
const redoBtn = button(tb, "redo", "Redo", () => history("redo"), "⇧⌘Z");
div("sep", tb);
button(tb, "save", "Download PDF", () => void save(), "⌘S");
button(tb, "info", "Performance HUD", () =>
	document.body.classList.toggle("hud-on"),
);
function syncHistory() {
	undoBtn.disabled = undoable === 0;
	redoBtn.disabled = redoable === 0;
}
syncHistory();

const ctxEdit = button(
	ctxEl,
	"edit",
	"Edit text",
	() => void act("edit"),
	"↵",
	"Edit",
);
const ctxSep = div("sep", ctxEl);
button(
	ctxEl,
	"trash",
	"Delete",
	() => void act("delete"),
	"⌫",
	"Delete",
).classList.add("danger");
button(
	ctxEl,
	"redact",
	"Redact: removes what's underneath",
	() => void act("redact"),
	undefined,
	"Redact",
).classList.add("danger");

input.addEventListener("input", () => render());
input.addEventListener("keydown", (e) => {
	e.stopPropagation();
	if (e.key === "Enter") {
		e.preventDefault();
		void commit();
	} else if (e.key === "Escape") {
		e.preventDefault();
		cancelEditor();
	}
});
input.addEventListener("blur", () => {
	if (ed && !ed.committing) void commit();
});
for (const t of ["pointerdown", "mousedown"] as const)
	input.addEventListener(t, (e) => e.stopPropagation());
// the editor sits above the canvas; hand scrolls back to the viewer
input.addEventListener(
	"wheel",
	(e) => {
		e.preventDefault();
		viewerEl.querySelector("canvas")?.dispatchEvent(new WheelEvent("wheel", e));
	},
	{ passive: false },
);

let moveQueued: PointerEvent | null = null;
let hoverSeq = 0;
viewerEl.addEventListener("pointermove", (e) => {
	if (!moveQueued) requestAnimationFrame(hoverAt);
	moveQueued = e;
});
viewerEl.addEventListener("pointerleave", () => {
	hover = null;
	pointer = null;
	updateCursor();
	render();
});
function hoverAt() {
	const e = moveQueued!;
	moveQueued = null;
	const at = e.buttons ? null : toPage(e.clientX, e.clientY);
	pointer = at;
	const seq = ++hoverSeq;
	if (!at || adding) {
		hover = null;
		updateCursor();
		return render();
	}
	void objs(at.page).then((list) => {
		if (seq !== hoverSeq) return;
		hover = lineAt(list, at.page, at.x, at.y);
		updateCursor();
		render();
	});
}

window.addEventListener("keydown", (e) => {
	if (
		(e.target as HTMLElement).closest?.(
			"input, textarea, select, [contenteditable]",
		)
	)
		return;
	const mod = e.metaKey || e.ctrlKey;
	const k = e.key.toLowerCase();
	if (mod && k === "z") {
		e.preventDefault();
		history(e.shiftKey ? "redo" : "undo");
	} else if (mod && k === "s") {
		e.preventDefault();
		void save();
	} else if (!mod && !e.altKey && k === "t") {
		e.preventDefault();
		setAdding(!adding);
	} else if (e.key === "Escape") {
		if (adding) setAdding(false);
		sel = null;
		clearNote();
		render();
	} else if ((e.key === "Backspace" || e.key === "Delete") && sel) {
		e.preventDefault();
		void act("delete");
	} else if (e.key === "Enter" && isText(sel)) {
		e.preventDefault();
		void act("edit");
	}
});

w.__editEvent = (e) => {
	if (e.type === "ready" || e.type === "layout") {
		layout = e.layout;
		schedule();
	} else if (e.type === "camera") {
		cam = e.camera;
		schedule();
	} else if (e.type === "view") page = e.page;
	else if (e.type === "click") void click(e.page, e.x, e.y);
	else if (e.type === "edited") {
		objects.clear();
		hover = null;
		if (e.structure) {
			sel = null;
			if (ed && !ed.committing) closeEditor();
			clearNote();
		}
		schedule();
	} else if (e.type === "edit-painted") {
		w.__editLog.push({ painted: e.page, ms: e.ms });
		painted.get(e.page)?.();
		if (statusEl.textContent && !statusEl.textContent.includes("painted"))
			statusEl.textContent += ` · painted ${e.ms.toFixed(0)} ms`;
	}
};
