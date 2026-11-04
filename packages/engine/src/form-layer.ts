// Main-thread side of form filling. Hit-tests widgets synchronously (iOS only
// shows the keyboard for an input focused inside the tap's own handler), edits
// text in a native input laid over the field, picks combo options from a
// native <select>, and sends each finished edit to the core. PDFium draws no
// caret, so typing happens in the DOM and only the committed value reaches it.

import type { Camera, CoreOptions, Cursor } from "./core";
import { type FormOp, type FormWidget, MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, widgetAt } from "./forms";
import type { Rect } from "./text";

export interface FormHit {
	page: number;
	widget: FormWidget;
	/** page points, top-left origin */
	x: number;
	y: number;
}

interface Deps {
	send(op: FormOp): void;
	layout(): Rect[];
	camera(): Camera;
	options(): CoreOptions;
}

type Editor = { page: number; widget: FormWidget; el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; done: boolean };

const css = (c: readonly number[]) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;

export const modifiers = (e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) =>
	(e.shiftKey ? MOD_SHIFT : 0) | (e.ctrlKey ? MOD_CTRL : 0) | (e.altKey ? MOD_ALT : 0) | (e.metaKey ? MOD_META : 0);

export class FormLayer {
	private widgets = new Map<number, FormWidget[]>();
	private editor: Editor | null = null;
	/** committed editors kept on screen until the page shows the edit (no flash of the old value) */
	private ghosts = new Map<number, { el: HTMLElement; page: number; widget: FormWidget; timer: ReturnType<typeof setTimeout> }>();
	private nextGhost = 1;

	constructor(
		private container: HTMLElement,
		private deps: Deps,
	) {}

	get active() {
		return this.widgets.size > 0;
	}

	setWidgets(page: number, widgets: FormWidget[]) {
		this.widgets.set(page, widgets);
	}

	/** another widget of the field (or this one, from elsewhere) changed */
	changed(name: string, value: string) {
		for (const ws of this.widgets.values()) for (const w of ws) if (w.name === name) w.value = value;
	}

	/** The interactive widget under a viewport point (css px), if any. */
	hit(sx: number, sy: number): FormHit | null {
		if (!this.widgets.size) return null;
		const cam = this.deps.camera();
		const dx = cam.x + sx / cam.zoom;
		const dy = cam.y + sy / cam.zoom;
		const layout = this.deps.layout();
		let lo = 0;
		let hi = layout.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (layout[mid]!.y <= dy) lo = mid;
			else hi = mid - 1;
		}
		const r = layout[lo];
		if (!r || dx < r.x || dx > r.x + r.w || dy < r.y || dy > r.y + r.h) return null;
		const x = dx - r.x;
		const y = dy - r.y;
		const widget = widgetAt(this.widgets.get(lo), x, y);
		return widget ? { page: lo, widget, x, y } : null;
	}

	cursor(hit: FormHit): Cursor {
		return hit.widget.kind === "text" ? "text" : "pointer";
	}

	/** A tap or click on a widget: must run inside the input event's handler (focus, pickers). */
	activate(hit: FormHit, mods: number) {
		const { widget, page } = hit;
		if (this.editor?.widget === widget && this.editor.page === page) return;
		this.commit();
		if (widget.kind === "text") this.openText(page, widget);
		else if (widget.kind === "combo" && widget.options?.length) this.openSelect(page, widget);
		else this.deps.send({ k: "click", page, x: hit.x, y: hit.y, mods });
	}

	/** Follows the camera (and layout changes). */
	update() {
		if (this.editor) this.place(this.editor.el, this.editor.page, this.editor.widget);
		for (const g of this.ghosts.values()) this.place(g.el, g.page, g.widget);
	}

	/** The page shows its edited fields now. */
	painted(page: number) {
		for (const [id, g] of this.ghosts) {
			if (g.page !== page) continue;
			clearTimeout(g.timer);
			g.el.remove();
			this.ghosts.delete(id);
		}
	}

	/** Finishes the open edit, sending its value. */
	commit() {
		const ed = this.editor;
		if (!ed || ed.done) return;
		ed.done = true;
		this.editor = null;
		const { el, page, widget } = ed;
		if (el instanceof HTMLSelectElement) {
			const option = el.selectedIndex;
			el.remove();
			if (option >= 0 && widget.options?.[option] !== widget.value) {
				this.deps.send({ k: "choose", page, index: widget.index, option });
				widget.value = widget.options?.[option] ?? widget.value;
			}
			return;
		}
		const value = el.value;
		if (value === widget.value) {
			el.remove();
			return;
		}
		this.deps.send({ k: "text", page, index: widget.index, value });
		widget.value = value;
		el.readOnly = true;
		el.tabIndex = -1;
		el.style.pointerEvents = "none";
		const id = this.nextGhost++;
		// Fallback for a page that is off screen (no frame draws it).
		const timer = setTimeout(() => {
			el.remove();
			this.ghosts.delete(id);
		}, 1500);
		this.ghosts.set(id, { el, page, widget, timer });
	}

	/** Drops the open edit without sending it. */
	cancel() {
		const ed = this.editor;
		if (!ed) return;
		ed.done = true;
		this.editor = null;
		ed.el.remove();
	}

	destroy() {
		this.cancel();
		for (const g of this.ghosts.values()) {
			clearTimeout(g.timer);
			g.el.remove();
		}
		this.ghosts.clear();
	}

	private style(el: HTMLElement) {
		const { dark, paper, ink } = this.deps.options();
		el.style.cssText = `position:absolute;left:0;top:0;z-index:3;box-sizing:border-box;margin:0;border:0;border-radius:0;outline:none;resize:none;overflow:hidden;font-family:Helvetica,Arial,sans-serif;line-height:1.15;user-select:text;-webkit-user-select:text;box-shadow:0 0 0 1.5px rgb(38,110,235);transform-origin:0 0;background:${dark ? css(paper) : "#fff"};color:${dark ? css(ink) : "#000"};`;
		el.style.setProperty("-webkit-appearance", "none");
		el.style.setProperty("-webkit-touch-callout", "default");
	}

	/** Sized in page points and scaled by the zoom, so the text matches the rendered field. */
	private place(el: HTMLElement, page: number, w: FormWidget) {
		const r = this.deps.layout()[page];
		if (!r) return;
		const cam = this.deps.camera();
		const z = cam.zoom;
		const width = w.rect[2] - w.rect[0];
		const height = w.rect[3] - w.rect[1];
		// iOS zooms the page into inputs with text under 16px: lay out at >=16px, then scale down.
		const size = w.fontSize || Math.max(6, Math.min(12, (w.multiline ? 12 : height * 0.7)));
		const k = Math.max(1, 16 / (size * z));
		el.style.width = `${width * z * k}px`;
		el.style.height = `${height * z * k}px`;
		el.style.fontSize = `${size * z * k}px`;
		el.style.padding = `${(w.multiline ? 2 : 0) * z * k}px ${2 * z * k}px`;
		el.style.transform = `translate(${(r.x + w.rect[0] - cam.x) * z}px,${(r.y + w.rect[1] - cam.y) * z}px) scale(${1 / k})`;
	}

	private openText(page: number, widget: FormWidget) {
		const el = document.createElement(widget.multiline ? "textarea" : "input");
		if (el instanceof HTMLInputElement) el.type = widget.password ? "password" : "text";
		el.value = widget.value;
		el.setAttribute("aria-label", widget.name);
		el.autocomplete = "off";
		el.spellcheck = false;
		el.className = "lector-form-field";
		this.style(el);
		this.place(el, page, widget);
		const ed: Editor = { page, widget, el, done: false };
		this.editor = ed;
		el.addEventListener("blur", () => {
			if (this.editor === ed) this.commit();
		});
		el.addEventListener("keydown", (e) => this.key(e as KeyboardEvent, ed));
		this.container.appendChild(el);
		el.focus({ preventScroll: true });
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.setSelectionRange(el.value.length, el.value.length);
	}

	private openSelect(page: number, widget: FormWidget) {
		const el = document.createElement("select");
		for (const label of widget.options!) el.add(new Option(label, label));
		el.selectedIndex = widget.options!.indexOf(widget.value);
		el.setAttribute("aria-label", widget.name);
		el.className = "lector-form-field";
		this.style(el);
		this.place(el, page, widget);
		const ed: Editor = { page, widget, el, done: false };
		this.editor = ed;
		el.addEventListener("change", () => {
			if (this.editor === ed) this.commit();
			this.container.focus({ preventScroll: true });
		});
		el.addEventListener("blur", () => {
			if (this.editor === ed) this.commit();
		});
		el.addEventListener("keydown", (e) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			this.cancel();
			this.container.focus({ preventScroll: true });
		});
		this.container.appendChild(el);
		el.focus({ preventScroll: true });
		// Opens the list where the browser supports it; elsewhere (iOS) focusing it does.
		try {
			(el as HTMLSelectElement & { showPicker?: () => void }).showPicker?.();
		} catch {}
	}

	private key(e: KeyboardEvent, ed: Editor) {
		if (e.isComposing) return;
		if (e.key === "Escape") {
			e.preventDefault();
			this.cancel();
			this.container.focus({ preventScroll: true });
		} else if (e.key === "Enter" && !(ed.el instanceof HTMLTextAreaElement)) {
			e.preventDefault();
			this.commit();
			this.container.focus({ preventScroll: true });
		} else if (e.key === "Tab") {
			const next = this.neighbour(ed.page, ed.widget, e.shiftKey ? -1 : 1);
			if (!next) return;
			e.preventDefault();
			this.commit();
			this.openText(next.page, next.widget);
		}
	}

	/** The next (or previous) text field among the pages whose widgets are known, in annotation order. */
	private neighbour(page: number, widget: FormWidget, dir: 1 | -1): { page: number; widget: FormWidget } | null {
		const all: { page: number; widget: FormWidget }[] = [];
		for (const p of [...this.widgets.keys()].sort((a, b) => a - b)) for (const w of this.widgets.get(p)!) if (w.kind === "text" && !w.readOnly) all.push({ page: p, widget: w });
		const i = all.findIndex((x) => x.page === page && x.widget === widget);
		return i < 0 ? null : (all[i + dir] ?? null);
	}
}
