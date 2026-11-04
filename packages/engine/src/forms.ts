// AcroForm fields: the widget geometry the main thread hit-tests, the edits
// sent to every raster worker, and which tiles an edit makes stale.

/** l, t, r, b in page points (top-left origin) */
export type Box = [number, number, number, number];

export type FieldKind = "text" | "checkbox" | "radio" | "combo" | "list" | "button" | "signature" | "unknown";

/** One widget (a field's box on a page). `index` is its annotation index on the page. */
export interface FormWidget {
	index: number;
	rect: Box;
	kind: FieldKind;
	name: string;
	value: string;
	readOnly: boolean;
	multiline?: boolean;
	password?: boolean;
	/** combo and list boxes */
	options?: string[];
	/** points; 0: auto-sized */
	fontSize?: number;
}

/**
 * An edit, applied by every raster worker so their documents stay identical.
 * Each one is atomic: no form focus survives it, so workers never diverge.
 */
export type FormOp =
	/** a press and release at a point (checkboxes, radios, list boxes, buttons) */
	| { k: "click"; page: number; x: number; y: number; mods: number }
	/** replace a text field's value */
	| { k: "text"; page: number; index: number; value: string }
	/** select a combo box option */
	| { k: "choose"; page: number; index: number; option: number };

/** FWL_EVENTFLAG modifier bits */
export const MOD_SHIFT = 1;
export const MOD_CTRL = 2;
export const MOD_ALT = 4;
export const MOD_META = 8;

/** Widgets the viewer handles (others stay inert and fall through to selection). */
export const interactive = (w: FormWidget) => !w.readOnly && w.kind !== "signature" && w.kind !== "unknown";

/** The topmost interactive widget at a page point. */
export function widgetAt(widgets: readonly FormWidget[] | undefined, x: number, y: number): FormWidget | null {
	if (!widgets) return null;
	for (let i = widgets.length - 1; i >= 0; i--) {
		const w = widgets[i]!;
		if (interactive(w) && x >= w.rect[0] && x <= w.rect[2] && y >= w.rect[1] && y <= w.rect[3]) return w;
	}
	return null;
}

const intersects = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * Edited regions per page. A tile's version is the latest edit that touches
 * it; tiles key on it, so an edit re-renders only the tiles over the field.
 */
export class FormDirt {
	private regions = new Map<number, { box: Box | null; ver: number }[]>();
	private ver = 0;
	private all = 0;

	/** `box`: the edited area (null: the whole page) */
	bump(page: number, box: Box | null) {
		const ver = ++this.ver;
		const list = this.regions.get(page) ?? [];
		const same = list.find((r) => (r.box === null ? box === null : box !== null && r.box.every((v, i) => v === box[i])));
		if (same) same.ver = ver;
		else list.push({ box, ver });
		this.regions.set(page, list);
	}

	/** every page changed (e.g. a reset button) */
	bumpAll() {
		this.all = ++this.ver;
	}

	/** version of a page region (null: the whole page) */
	version(page: number, box: Box | null): number {
		let v = this.all;
		for (const r of this.regions.get(page) ?? []) if (r.ver > v && (!box || !r.box || intersects(box, r.box))) v = r.ver;
		return v;
	}

	/** the page may differ from the document as it was opened */
	edited(page: number) {
		return this.all > 0 || this.regions.has(page);
	}

	get any() {
		return this.ver > 0;
	}
}
