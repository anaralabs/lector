import type { PDFPageProxy } from "pdfjs-dist";
import type { HighlightRect } from "../internal";

export interface SelectionPageText {
	text: string;
	lineBreaks: number[];
}

/** A mounted text layer. Only this object owns DOM nodes; snapshots never do. */
export class SelectionPage {
	readonly nodes: { node: Text; start: number; end: number }[] = [];
	readonly content: SelectionPageText;
	constructor(
		readonly element: HTMLElement,
		readonly pageNumber: number,
		readonly width: number,
		readonly height: number,
	) {
		const walker = element.ownerDocument.createTreeWalker(
			element,
			NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
		);
		const chunks: string[] = [];
		const lineBreaks: number[] = [];
		let offset = 0;
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node.nodeType === Node.TEXT_NODE) {
				const text = node.textContent ?? "";
				if (!text) continue;
				this.nodes.push({
					node: node as Text,
					start: offset,
					end: offset + text.length,
				});
				chunks.push(text);
				offset += text.length;
			} else if ((node as Element).tagName === "BR") lineBreaks.push(offset);
		}
		this.content = { text: chunks.join(""), lineBreaks };
	}

	offset(node: Node, offset: number): number | null {
		if (!this.element.contains(node)) return null;
		const item = this.nodes.find((item) => item.node === node);
		if (item)
			return item.start + Math.max(0, Math.min(offset, item.end - item.start));
		const range = this.element.ownerDocument.createRange();
		range.selectNodeContents(this.element);
		try {
			range.setEnd(node, offset);
		} catch {
			return null;
		}
		return Math.min(range.toString().length, this.content.text.length);
	}

	point(offset: number, end = false): { node: Text; offset: number } | null {
		const index = Math.max(0, Math.min(offset, this.content.text.length));
		const item =
			this.nodes.find((item) => (end ? item.end >= index : item.end > index)) ??
			this.nodes.at(-1);
		return item
			? { node: item.node, offset: Math.max(0, index - item.start) }
			: null;
	}

	rects(from: number, to: number): HighlightRect[] {
		const bounds = this.element.getBoundingClientRect();
		const scaleX = bounds.width / this.width || 1;
		const scaleY = bounds.height / this.height || 1;
		const rects: HighlightRect[] = [];
		// Per-text-node ranges exclude page wrappers, column gutters and BR boxes.
		// The browser handles proportional fonts, ligatures, bidi and vertical runs.
		for (const item of this.nodes) {
			const start = Math.max(from, item.start);
			const end = Math.min(to, item.end);
			if (
				end <= start ||
				!item.node.textContent
					?.slice(start - item.start, end - item.start)
					.trim()
			)
				continue;
			const range = this.element.ownerDocument.createRange();
			range.setStart(item.node, start - item.start);
			range.setEnd(item.node, end - item.start);
			for (const rect of range.getClientRects()) {
				if (rect.width <= 0 || rect.height <= 0) continue;
				rects.push({
					pageNumber: this.pageNumber,
					left: (rect.left - bounds.left) / scaleX,
					top: (rect.top - bounds.top) / scaleY,
					width: rect.width / scaleX,
					height: rect.height / scaleY,
				});
			}
		}
		return rects;
	}
}

/** Materialize one missing selected page as text only, never as a page canvas. */
export async function withSelectionPage<T>(
	proxy: PDFPageProxy,
	owner: Document,
	signal: AbortSignal,
	read: (page: SelectionPage) => T,
): Promise<T> {
	signal.throwIfAborted();
	const { TextLayer } = await import("pdfjs-dist/legacy/build/pdf.mjs");
	signal.throwIfAborted();
	const viewport = proxy.getViewport({ scale: 1 });
	const container = owner.createElement("div");
	container.className = "textLayer";
	container.setAttribute("aria-hidden", "true");
	container.style.cssText = `position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:${viewport.width}px;height:${viewport.height}px;--scale-factor:1;--total-scale-factor:1;`;
	owner.body.append(container);
	let layer: InstanceType<typeof TextLayer> | undefined;
	const cancel = () => layer?.cancel();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		layer = new TextLayer({
			container,
			viewport,
			textContentSource: proxy.streamTextContent(),
		});
		await layer.render();
		signal.throwIfAborted();
		const unrotated = proxy.getViewport({ scale: 1, rotation: 0 });
		container.style.width = `${unrotated.width}px`;
		container.style.height = `${unrotated.height}px`;
		return read(
			new SelectionPage(
				container,
				proxy.pageNumber,
				viewport.width,
				viewport.height,
			),
		);
	} finally {
		signal.removeEventListener("abort", cancel);
		layer?.cancel();
		container.remove();
	}
}
