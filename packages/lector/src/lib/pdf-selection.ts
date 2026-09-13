import type { PDFPageProxy } from "pdfjs-dist";
import type { HighlightRect } from "../internal";
import {
	SelectionPage,
	type SelectionPageText,
	withSelectionPage,
} from "./selection-page";
import {
	normalizeSelectionText,
	type SelectionTextOptions,
} from "./text-normalization";

/** One-based page and UTF-16 offset in that page's selectable text (BRs excluded). */
export interface PDFTextAnchor {
	pageNumber: number;
	offset: number;
}
export interface PDFTextSelection {
	anchor: PDFTextAnchor;
	focus: PDFTextAnchor;
	status: "loading" | "ready" | "error";
	error?: unknown;
}
export interface PDFSelectionResult {
	anchor: PDFTextAnchor;
	focus: PDFTextAnchor;
	text: string;
	highlights: HighlightRect[];
	underlines: HighlightRect[];
	isCollapsed: false;
}
type PageSnapshot = {
	content: SelectionPageText;
	from: number;
	to: number;
	rects: HighlightRect[];
};
type NativePoint = { node: Node; offset: number };
type Projection = { anchor: NativePoint; focus: NativePoint };
const sameAnchor = (a: PDFTextAnchor, b: PDFTextAnchor) =>
	a.pageNumber === b.pageNumber && a.offset === b.offset;
const compare = (a: PDFTextAnchor, b: PDFTextAnchor) =>
	a.pageNumber - b.pageNumber || a.offset - b.offset;
const samePoint = (a: NativePoint, node: Node | null, offset: number) =>
	a.node === node && a.offset === offset;

const selectionOwners = new WeakMap<Document, PDFSelectionController>();

/** Document-owned selection; mounted text layers are replaceable projections. */
export class PDFSelectionController {
	private snapshot: PDFTextSelection | null = null;
	private listeners = new Set<() => void>();
	private layers = new Map<number, SelectionPage>();
	private pages = new Map<number, PageSnapshot>();
	private container: HTMLElement | null = null;
	private projection: Projection | null = null;
	private frame: number | null = null;
	private work: AbortController | null = null;
	private structuralChange = false;
	private drag: {
		anchor: PDFTextAnchor;
		x: number;
		y: number;
		pointerId: number;
		moved: boolean;
		started: boolean;
		shift: boolean;
	} | null = null;
	private connectedCleanup: (() => void) | null = null;
	private generation = 0;
	private keyboardWork: AbortController | null = null;
	private keyboardMoves: { direction: string; granularity: string }[] = [];

	constructor(
		private readonly options: {
			pageCount: number;
			loadPage: (page: number) => Promise<PDFPageProxy>;
			revealPage?: (page: number) => void;
		},
	) {}
	getSnapshot = () => this.snapshot;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	get isDragging() {
		return this.drag !== null;
	}
	includesPage(page: number) {
		const range = this.ordered();
		return Boolean(
			range && page >= range.start.pageNumber && page <= range.end.pageNumber,
		);
	}
	private publish(snapshot: PDFTextSelection | null) {
		this.snapshot = snapshot;
		for (const listener of this.listeners) listener();
	}
	private ordered() {
		if (!this.snapshot) return null;
		const { anchor, focus } = this.snapshot;
		return compare(anchor, focus) <= 0
			? { start: anchor, end: focus }
			: { start: focus, end: anchor };
	}
	private bounds(page: number, length: number) {
		const range = this.ordered()!;
		return {
			from:
				page === range.start.pageNumber
					? Math.min(range.start.offset, length)
					: 0,
			to:
				page === range.end.pageNumber
					? Math.min(range.end.offset, length)
					: length,
		};
	}
	private remember(page: SelectionPage) {
		if (!this.includesPage(page.pageNumber)) return;
		for (const point of [this.snapshot!.anchor, this.snapshot!.focus]) {
			if (
				point.pageNumber === page.pageNumber &&
				point.offset > page.content.text.length
			)
				throw new RangeError("Selection offset exceeds page text length");
		}
		const { from, to } = this.bounds(page.pageNumber, page.content.text.length);
		const cached = this.pages.get(page.pageNumber);
		if (
			cached?.content.text === page.content.text &&
			cached.from === from &&
			cached.to === to
		)
			return;
		this.pages.set(page.pageNumber, {
			content: page.content,
			from,
			to,
			rects: page.rects(from, to),
		});
	}
	private complete() {
		const range = this.ordered();
		if (!range) return false;
		for (let n = range.start.pageNumber; n <= range.end.pageNumber; n++) {
			const page = this.pages.get(n);
			if (!page) return false;
			const bounds = this.bounds(n, page.content.text.length);
			if (page.from !== bounds.from || page.to !== bounds.to) return false;
		}
		return true;
	}

	setSelection = (anchor: PDFTextAnchor, focus: PDFTextAnchor) => {
		for (const point of [anchor, focus]) {
			const text =
				this.layers.get(point.pageNumber)?.content.text ??
				this.pages.get(point.pageNumber)?.content.text;
			if (text !== undefined && point.offset > text.length)
				throw new RangeError("Selection offset exceeds page text length");
			if (
				!Number.isInteger(point.pageNumber) ||
				point.pageNumber < 1 ||
				point.pageNumber > this.options.pageCount ||
				!Number.isInteger(point.offset) ||
				point.offset < 0
			)
				throw new RangeError(
					"Selection anchors need a valid page and nonnegative UTF-16 offset",
				);
		}
		if (sameAnchor(anchor, focus)) {
			const drag = this.drag;
			this.clear();
			this.drag = drag;
			return;
		}
		if (
			this.snapshot &&
			this.snapshot.status !== "error" &&
			sameAnchor(this.snapshot.anchor, anchor) &&
			sameAnchor(this.snapshot.focus, focus)
		)
			return;
		if (this.container) {
			const owner = this.container.ownerDocument;
			const previous = selectionOwners.get(owner);
			if (previous !== this) previous?.clear();
			selectionOwners.set(owner, this);
		}
		this.work?.abort();
		this.keyboardWork?.abort();
		this.keyboardWork = null;
		this.generation++;
		this.snapshot = {
			anchor: { ...anchor },
			focus: { ...focus },
			status: "loading",
		};
		for (const n of this.pages.keys())
			if (!this.includesPage(n)) this.pages.delete(n);
		for (const page of this.layers.values()) this.remember(page);
		this.publish({
			...this.snapshot,
			status: this.complete() ? "ready" : "loading",
		});
		this.project();
		this.schedule();
		this.hydrate();
	};

	clear = () => {
		const owner = this.container?.ownerDocument;
		if (owner && selectionOwners.get(owner) === this)
			selectionOwners.delete(owner);
		this.work?.abort();
		this.keyboardWork?.abort();
		this.keyboardWork = null;
		this.generation++;
		this.pages.clear();
		this.keyboardMoves = [];
		this.drag = null;
		const selection = this.container?.ownerDocument.getSelection();
		if (
			this.projection &&
			selection &&
			samePoint(
				this.projection.anchor,
				selection.anchorNode,
				selection.anchorOffset,
			) &&
			samePoint(
				this.projection.focus,
				selection.focusNode,
				selection.focusOffset,
			)
		)
			selection.removeAllRanges();
		this.projection = null;
		if (this.snapshot) this.publish(null);
	};

	getText = (options: SelectionTextOptions = {}): string | null => {
		const range = this.ordered();
		if (!range || !this.complete()) return null;
		const chunks: string[] = [];
		for (let n = range.start.pageNumber; n <= range.end.pageNumber; n++) {
			const page = this.pages.get(n)!;
			const pieces: string[] = [];
			let offset = page.from;
			for (const end of page.content.lineBreaks) {
				if (end <= page.from || end >= page.to) continue;
				pieces.push(page.content.text.slice(offset, end), "\n");
				offset = end;
			}
			pieces.push(page.content.text.slice(offset, page.to));
			chunks.push(pieces.join(""));
		}
		return normalizeSelectionText(chunks.join("\n\n"), options);
	};
	getSelection = (
		options?: SelectionTextOptions,
	): PDFSelectionResult | null => {
		const text = this.getText(options);
		if (text === null || !this.snapshot) return null;
		const range = this.ordered()!;
		const highlights: HighlightRect[] = [];
		for (let n = range.start.pageNumber; n <= range.end.pageNumber; n++)
			highlights.push(...this.pages.get(n)!.rects.map((rect) => ({ ...rect })));
		return {
			anchor: { ...this.snapshot.anchor },
			focus: { ...this.snapshot.focus },
			text,
			highlights,
			underlines: highlights.map((rect) => ({
				...rect,
				top: rect.top + rect.height - 1,
				height: 1,
			})),
			isCollapsed: false,
		};
	};
	getSelectionAsync = async (
		options?: SelectionTextOptions,
	): Promise<PDFSelectionResult | null> => {
		const generation = this.generation;
		// Completion can come from mounted layers as well as background hydration.
		// Wait on selection state so redundant/stalled page loads cannot delay it.
		await new Promise<void>((resolve) => {
			if (this.snapshot?.status !== "loading") {
				resolve();
				return;
			}
			const unsubscribe = this.subscribe(() => {
				if (
					generation !== this.generation ||
					this.snapshot?.status !== "loading"
				) {
					unsubscribe();
					resolve();
				}
			});
		});
		if (generation !== this.generation)
			throw new DOMException("Selection changed", "AbortError");
		if (this.snapshot?.status === "error") throw this.snapshot.error;
		return this.getSelection(options);
	};

	private finishSelection() {
		if (this.snapshot?.status !== "loading" || !this.complete()) return;
		// A mounted layer may finish first. Its result makes hydration redundant.
		this.work?.abort();
		this.work = null;
		this.publish({ ...this.snapshot, status: "ready" });
	}

	registerLayer(
		element: HTMLElement,
		pageNumber: number,
		width: number,
		height: number,
	) {
		const page = new SelectionPage(element, pageNumber, width, height);
		this.layers.set(pageNumber, page);
		try {
			this.remember(page);
			this.finishSelection();
		} catch (error) {
			this.work?.abort();
			if (this.snapshot)
				this.publish({ ...this.snapshot, status: "error", error });
		}
		this.schedule();
		return () => {
			if (this.layers.get(pageNumber) !== page) return;
			this.structuralChange = true;
			this.layers.delete(pageNumber);
			// Do not retain detached page DOM through a native projection.
			this.projection = null;
			this.schedule();
		};
	}

	private anchorFor(node: Node | null, offset: number): PDFTextAnchor | null {
		if (!node) return null;
		for (const [pageNumber, page] of this.layers) {
			const index = page.offset(node, offset);
			if (index !== null) return { pageNumber, offset: index };
		}
		return null;
	}
	private capture = () => {
		const owner = this.container?.ownerDocument;
		const active = owner?.activeElement;
		// External controls may collapse or extend the native range on focus/keys.
		// Keep the saved PDF selection intact while those controls own focus.
		if (
			active &&
			active !== owner?.body &&
			!this.container?.contains(active) &&
			!active.closest(
				'input, textarea, [contenteditable]:not([contenteditable="false"])',
			)
		)
			return;
		const selection = owner?.getSelection();
		if (!selection || selection.rangeCount > 1) return;
		if (
			this.projection &&
			samePoint(
				this.projection.anchor,
				selection.anchorNode,
				selection.anchorOffset,
			) &&
			samePoint(
				this.projection.focus,
				selection.focusNode,
				selection.focusOffset,
			)
		)
			return;
		if (this.structuralChange) {
			this.schedule();
			return;
		}
		if (selection.isCollapsed) {
			if (
				this.structuralChange ||
				this.drag ||
				(!this.projection &&
					this.snapshot &&
					(!this.layers.has(this.snapshot.anchor.pageNumber) ||
						!this.layers.has(this.snapshot.focus.pageNumber)))
			) {
				this.schedule();
				return;
			}
			if (this.snapshot) this.clear();
			return;
		}
		const anchor = this.anchorFor(selection.anchorNode, selection.anchorOffset);
		const focus = this.anchorFor(selection.focusNode, selection.focusOffset);
		if (anchor && focus) {
			if (this.drag && !this.drag.started) {
				if (!this.drag.shift && !this.drag.moved) this.drag.anchor = anchor;
				this.drag.started = true;
			}
			const savedAnchor =
				this.projection &&
				samePoint(
					this.projection.anchor,
					selection.anchorNode,
					selection.anchorOffset,
				)
					? this.snapshot?.anchor
					: undefined;
			this.setSelection(this.drag?.anchor ?? savedAnchor ?? anchor, focus);
			this.projection = {
				anchor: { node: selection.anchorNode!, offset: selection.anchorOffset },
				focus: { node: selection.focusNode!, offset: selection.focusOffset },
			};
		} else if (
			!this.structuralChange &&
			!this.drag &&
			(selection.anchorNode || selection.focusNode)
		)
			this.clear();
	};

	private schedule() {
		if (!this.container || this.frame !== null) return;
		this.frame =
			this.container.ownerDocument.defaultView!.requestAnimationFrame(() => {
				this.frame = null;
				this.project();
				this.structuralChange = false;
				this.flushKeyboard();
				if (this.drag) this.autoScroll();
			});
	}
	private project() {
		const range = this.ordered();
		if (!range || !this.container) return;
		const visible = [...this.layers.values()]
			.filter((page) => this.includesPage(page.pageNumber) && page.nodes.length)
			.sort((a, b) => a.pageNumber - b.pageNumber);
		const first = visible[0];
		const last = visible.at(-1);
		if (!first || !last) return;
		const start = first.point(
			this.bounds(first.pageNumber, first.content.text.length).from,
		);
		const end = last.point(
			this.bounds(last.pageNumber, last.content.text.length).to,
			true,
		);
		if (!start || !end) return;
		const backwards = compare(this.snapshot!.anchor, this.snapshot!.focus) > 0;
		const anchor = backwards ? end : start;
		const focus = backwards ? start : end;
		const selection = this.container.ownerDocument.getSelection()!;
		this.projection = { anchor, focus };
		if (
			!samePoint(anchor, selection.anchorNode, selection.anchorOffset) ||
			!samePoint(focus, selection.focusNode, selection.focusOffset)
		)
			selection.setBaseAndExtent(
				anchor.node,
				anchor.offset,
				focus.node,
				focus.offset,
			);
	}

	private hydrate() {
		if (!this.snapshot || this.complete() || !this.container) {
			return;
		}
		const range = this.ordered()!;
		const owner = this.container.ownerDocument;
		const controller = new AbortController();
		this.work = controller;
		const generation = this.generation;
		let next = range.start.pageNumber;
		const worker = async () => {
			while (next <= range.end.pageNumber) {
				controller.signal.throwIfAborted();
				const n = next++;
				const cached = this.pages.get(n);
				if (cached) {
					const bounds = this.bounds(n, cached.content.text.length);
					if (bounds.from === cached.from && bounds.to === cached.to) continue;
				}
				const page = await this.options.loadPage(n);
				controller.signal.throwIfAborted();
				await withSelectionPage(page, owner, controller.signal, (page) =>
					this.remember(page),
				);
			}
		};
		void Promise.all([worker(), worker()])
			.then(() => {
				if (!controller.signal.aborted && generation === this.generation) {
					this.finishSelection();
					this.schedule();
				}
			})
			.catch((error) => {
				if (
					!controller.signal.aborted &&
					generation === this.generation &&
					this.snapshot
				) {
					this.publish({ ...this.snapshot, status: "error", error });
					controller.abort();
				}
			});
	}

	private caret(x: number, y: number): PDFTextAnchor | null {
		const owner = this.container!.ownerDocument;
		const doc = owner as Document & {
			caretPositionFromPoint?: (
				x: number,
				y: number,
			) => { offsetNode: Node; offset: number } | null;
			caretRangeFromPoint?: (x: number, y: number) => Range | null;
		};
		const position = doc.caretPositionFromPoint?.(x, y);
		if (position) return this.anchorFor(position.offsetNode, position.offset);
		const range = doc.caretRangeFromPoint?.(x, y);
		return range
			? this.anchorFor(range.startContainer, range.startOffset)
			: null;
	}
	private autoScroll() {
		if (!this.drag?.moved || !this.container) return;
		const bounds = this.container.getBoundingClientRect();
		const { x, y } = this.drag;
		const edge = Math.min(40, bounds.height / 4);
		const delta =
			y < bounds.top + edge
				? -Math.min(24, (bounds.top + edge - y) * 0.5)
				: y > bounds.bottom - edge
					? Math.min(24, (y - bounds.bottom + edge) * 0.5)
					: 0;
		if (delta) this.container.scrollTop += delta;
		const focus = this.caret(
			Math.max(bounds.left + 1, Math.min(x, bounds.right - 1)),
			Math.max(bounds.top + 1, Math.min(y, bounds.bottom - 1)),
		);
		if (focus) this.setSelection(this.drag.anchor, focus);
		if (delta) this.schedule();
	}

	private flushKeyboard() {
		if (!this.snapshot || !this.keyboardMoves.length || this.keyboardWork)
			return;
		const page = this.layers.get(this.snapshot.focus.pageNumber);
		if (!page) {
			this.options.revealPage?.(this.snapshot.focus.pageNumber);
			return;
		}
		const move = this.keyboardMoves.shift()!;
		const native = this.container!.ownerDocument.getSelection() as Selection & {
			modify?: (alter: string, direction: string, granularity: string) => void;
		};
		if (!native?.modify) return;
		const { anchor, focus } = this.snapshot;
		native.modify("extend", move.direction, move.granularity);
		const next = this.anchorFor(native.focusNode, native.focusOffset);
		if (next && !sameAnchor(next, focus)) {
			this.setSelection(anchor, next);
		} else {
			// A browser cannot step into a text layer that the virtualizer hasn't mounted.
			const point = page.point(focus.offset);
			const rtl =
				point &&
				this.container!.ownerDocument.defaultView!.getComputedStyle(
					point.node.parentElement!,
				).direction === "rtl";
			const backwards =
				move.direction === "backward" ||
				move.direction === (rtl ? "right" : "left");
			if (
				move.granularity === "lineboundary" ||
				(backwards
					? focus.offset >
						(move.granularity === "line"
							? (page.content.lineBreaks[0] ?? 0)
							: 0)
					: focus.offset <
						(move.granularity === "line"
							? (page.content.lineBreaks.at(-1) ?? page.content.text.length)
							: page.content.text.length))
			) {
				this.schedule();
				return;
			}
			const n = focus.pageNumber + (backwards ? -1 : 1);
			if (n >= 1 && n <= this.options.pageCount) {
				if (!backwards) {
					this.setSelection(anchor, { pageNumber: n, offset: 0 });
					this.options.revealPage?.(n);
				} else {
					const generation = this.generation;
					const controller = new AbortController();
					this.keyboardWork = controller;
					const owner = this.container!.ownerDocument;
					void this.options
						.loadPage(n)
						.then((proxy) =>
							withSelectionPage(
								proxy,
								owner,
								controller.signal,
								(page) => page.content.text.length,
							),
						)
						.then((length) => {
							if (
								controller.signal.aborted ||
								generation !== this.generation ||
								!this.container
							)
								return;
							this.setSelection(anchor, { pageNumber: n, offset: length });
							this.options.revealPage?.(n);
						})
						.catch(() => {
							/* A failed page load leaves the existing selection intact. */
						})
						.finally(() => {
							if (this.keyboardWork === controller) this.keyboardWork = null;
							this.schedule();
						});
				}
			}
		}
		if (this.keyboardMoves.length) this.schedule();
	}

	connect(container: HTMLElement) {
		this.connectedCleanup?.();
		this.container = container;
		const owner = container.ownerDocument;
		const events = new AbortController();
		const { signal } = events;
		const down = (event: PointerEvent) => {
			if (event.defaultPrevented) return;
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest("button, a, [role=button], [data-selection-tooltip]"))
				return;
			if (!container.contains(event.target as Node)) {
				this.clear();
				return;
			}
			if (
				event.defaultPrevented ||
				event.button !== 0 ||
				event.pointerType === "touch" ||
				!container.contains(event.target as Node)
			)
				return;
			const point = this.caret(event.clientX, event.clientY);
			if (!point) return;
			const anchor =
				event.shiftKey && this.snapshot ? this.snapshot.anchor : point;
			if (!event.shiftKey) this.clear();
			this.drag = {
				anchor,
				x: event.clientX,
				y: event.clientY,
				pointerId: event.pointerId,
				moved: false,
				started: false,
				shift: event.shiftKey,
			};
			this.schedule();
		};
		const move = (event: PointerEvent) => {
			if (!this.drag || event.pointerId !== this.drag.pointerId) return;
			this.drag.moved ||=
				Math.abs(this.drag.x - event.clientX) +
					Math.abs(this.drag.y - event.clientY) >
				2;
			this.drag.x = event.clientX;
			this.drag.y = event.clientY;
			this.schedule();
		};
		const up = () => {
			this.capture();
			this.drag = null;
		};
		owner.addEventListener("selectionchange", this.capture, { signal });
		owner.addEventListener("pointerdown", down, { signal });
		owner.addEventListener("pointermove", move, { signal });
		owner.addEventListener("pointerup", up, { signal });
		owner.addEventListener("pointercancel", up, { signal });
		owner.defaultView!.addEventListener("blur", up, { signal });
		const cancelKeyboard = () => {
			this.keyboardMoves = [];
			this.keyboardWork?.abort();
			this.keyboardWork = null;
		};
		container.addEventListener(
			"focusout",
			(event) => {
				if (!container.contains(event.relatedTarget as Node | null))
					cancelKeyboard();
			},
			{ signal },
		);
		owner.defaultView!.addEventListener("blur", cancelKeyboard, { signal });
		container.addEventListener(
			"keydown",
			(event) => {
				if (
					event.defaultPrevented ||
					(event.target instanceof Element &&
						event.target.closest(
							'input, textarea, [contenteditable]:not([contenteditable="false"])',
						))
				)
					return;
				if (event.key === "Escape" && this.snapshot) {
					this.clear();
					return;
				}
				if (!event.shiftKey || !this.snapshot) return;
				const directions: Record<string, string> = {
					ArrowLeft: "left",
					ArrowRight: "right",
					ArrowUp: "backward",
					ArrowDown: "forward",
					Home: "backward",
					End: "forward",
				};
				const direction = directions[event.key];
				if (!direction) return;
				const native = owner.getSelection() as Selection & { modify?: unknown };
				if (!native?.modify) return;
				event.preventDefault();
				const boundary =
					event.key === "Home" ||
					event.key === "End" ||
					(event.metaKey &&
						(event.key === "ArrowLeft" || event.key === "ArrowRight"));
				const granularity = boundary
					? "lineboundary"
					: event.key === "ArrowUp" || event.key === "ArrowDown"
						? "line"
						: event.ctrlKey || event.altKey
							? "word"
							: "character";
				this.keyboardMoves.push({ direction, granularity });
				this.schedule();
			},
			{ signal },
		);
		const cleanup = () => {
			events.abort();
			if (this.frame !== null)
				owner.defaultView!.cancelAnimationFrame(this.frame);
			this.frame = null;
			this.clear();
			this.container = null;
			this.connectedCleanup = null;
		};
		this.connectedCleanup = cleanup;
		this.hydrate();
		this.schedule();
		return cleanup;
	}
}
