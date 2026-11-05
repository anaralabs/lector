// Placeholders over pages PDFium could not render. Hosts restyle `.lector-page-failed` or its CSS variables.

import type { Camera } from "./core";
import type { Rect } from "./text";

export const FAILED_PAGE_LABEL = "This page could not be displayed";

export class FailedPages {
	private root: HTMLDivElement | null = null;
	private els = new Map<number, HTMLDivElement>();
	private layout: Rect[] = [];

	constructor(private container: HTMLElement) {}

	add(page: number) {
		if (this.els.has(page)) return;
		const el = document.createElement("div");
		el.className = "lector-page-failed";
		el.dataset.page = String(page);
		el.setAttribute("role", "note");
		el.textContent = FAILED_PAGE_LABEL;
		el.style.cssText =
			"position:absolute;display:flex;align-items:center;justify-content:center;text-align:center;box-sizing:border-box;padding:24px;font:12px/1.4 system-ui,sans-serif;color:var(--lector-page-failed-color,rgba(128,128,128,.85));background:var(--lector-page-failed-background,transparent);";
		this.ensureRoot().appendChild(el);
		this.els.set(page, el);
		this.place(page, el);
	}

	setLayout(layout: Rect[]) {
		this.layout = layout;
		for (const [page, el] of this.els) this.place(page, el);
	}

	setCamera(cam: Camera) {
		if (this.root) this.root.style.transform = `matrix(${cam.zoom},0,0,${cam.zoom},${-cam.x * cam.zoom},${-cam.y * cam.zoom})`;
	}

	destroy() {
		this.root?.remove();
		this.root = null;
		this.els.clear();
	}

	private ensureRoot() {
		if (this.root) return this.root;
		const root = document.createElement("div");
		root.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;pointer-events:none;z-index:1;";
		this.container.appendChild(root);
		this.root = root;
		return root;
	}

	private place(page: number, el: HTMLDivElement) {
		const r = this.layout[page];
		el.style.display = r ? "flex" : "none";
		if (!r) return;
		el.style.left = `${r.x}px`;
		el.style.top = `${r.y}px`;
		el.style.width = `${r.w}px`;
		el.style.height = `${r.h}px`;
	}
}
