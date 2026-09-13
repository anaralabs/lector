type Caret = { node: Node; offset: number };
type TextBox = { node: Text; rect: DOMRect };
type ViewportRef = { current: HTMLDivElement | null };

const interactive =
	'a, button, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="textbox"], [data-lector-selection-ignore]';

const distance = (value: number, start: number, end: number) =>
	Math.max(start - value, 0, value - end);

/** Prefer the line under the pointer, including its empty leading/trailing margin. */
function nearestBox(boxes: TextBox[], x: number, y: number) {
	let nearest: TextBox | undefined;
	let best = Number.POSITIVE_INFINITY;
	for (const box of boxes) {
		const { rect } = box;
		const dx = distance(x, rect.left, rect.right);
		const dy = distance(y, rect.top, rect.bottom);
		// A line's margin must beat a longer neighbouring line. The horizontal
		// distance still distinguishes columns and separate runs on the same line.
		const score = dy * dy + Math.min(dx, 30) ** 2 / 100 + dx / 10000;
		if (score < best) {
			best = score;
			nearest = box;
		}
	}
	return nearest;
}

function caretInBox({ node, rect }: TextBox, x: number, y: number): Caret {
	const doc = node.ownerDocument;
	const px = Math.min(Math.max(x, rect.left + 0.1), rect.right - 0.1);
	const py = Math.min(Math.max(y, rect.top + 0.1), rect.bottom - 0.1);
	const caretDoc = doc as Document & {
		caretPositionFromPoint?: (
			x: number,
			y: number,
		) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
	};
	const position = caretDoc.caretPositionFromPoint?.(px, py);
	if (position?.offsetNode === node) return { node, offset: position.offset };
	const range = caretDoc.caretRangeFromPoint?.(px, py);
	if (range?.startContainer === node)
		return { node, offset: range.startOffset };

	// Browser hit-testing may return an unrelated absolutely positioned span.
	// Resolve against this text's actual caret rects instead (also handles RTL
	// and transformed text). Never split a surrogate pair.
	const probe = doc.createRange();
	let offset = 0;
	let best = Number.POSITIVE_INFINITY;
	let previous: { offset: number; rect: DOMRect } | undefined;
	for (let i = 0; i <= node.length; ) {
		probe.setStart(node, i);
		probe.collapse(true);
		const rects = Array.from(probe.getClientRects());
		// WebKit can omit the collapsed rect at the end of an RTL run.
		// Mirror the previous caret across the final glyph to recover that
		// boundary, including when the text is rotated.
		if (!rects.length && i === node.length && previous) {
			probe.setStart(node, previous.offset);
			probe.setEnd(node, i);
			const glyph = probe.getBoundingClientRect();
			const prior = previous.rect;
			rects.push(
				new DOMRect(
					glyph.left + glyph.right - prior.right,
					glyph.top + glyph.bottom - prior.bottom,
					prior.width,
					prior.height,
				),
			);
		}
		for (const r of rects) {
			const score =
				distance(x, r.left, r.right) ** 2 + distance(y, r.top, r.bottom) ** 2;
			if (score < best) {
				best = score;
				offset = i;
			}
		}
		if (rects[0]) previous = { offset: i, rect: rects[0] };
		i += (node.data.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
	}
	return { node, offset };
}

function createSelectionManager(viewport: ViewportRef, doc: Document) {
	const layers = new Set<HTMLDivElement>();
	const win = doc.defaultView!;
	const controller = new AbortController();
	const { signal } = controller;
	let drag: { anchor: Caret; x: number; y: number } | null = null;
	let boxes: TextBox[] | null = null;
	let frame = 0;
	let mousePointer = true;

	const invalidate = () => {
		boxes = null;
		if (drag && !frame) frame = win.requestAnimationFrame(tick);
	};
	const contains = (node: Node | null) =>
		!!node && [...layers].some((layer) => layer.contains(node));
	const reset = () => {
		drag = null;
		boxes = null;
		win.cancelAnimationFrame(frame);
		frame = 0;
		for (const layer of layers) layer.classList.remove("selecting");
	};
	const readBoxes = () => {
		if (boxes) return boxes;
		boxes = [];
		for (const layer of layers) {
			const walker = doc.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const parent = node.parentElement;
				if (
					!node.textContent?.trim() ||
					!parent ||
					parent.closest('[role="img"], .endOfContent') ||
					win.getComputedStyle(parent).userSelect === "none"
				)
					continue;
				const range = doc.createRange();
				range.selectNodeContents(node);
				for (const rect of range.getClientRects()) {
					if (rect.width > 0 && rect.height > 0)
						boxes.push({ node: node as Text, rect });
				}
			}
		}
		return boxes;
	};
	const resolve = (x: number, y: number) => {
		const box = nearestBox(readBoxes(), x, y);
		return box ? caretInBox(box, x, y) : null;
	};
	const update = () => {
		if (!drag) return;
		if (!drag.anchor.node.isConnected) {
			reset();
			return;
		}
		const focus = resolve(drag.x, drag.y);
		const selection = doc.getSelection();
		if (!focus || !selection) return;
		if (
			selection.anchorNode === drag.anchor.node &&
			selection.anchorOffset === drag.anchor.offset &&
			selection.focusNode === focus.node &&
			selection.focusOffset === focus.offset
		)
			return;
		selection.setBaseAndExtent(
			drag.anchor.node,
			drag.anchor.offset,
			focus.node,
			focus.offset,
		);
	};
	const tick = () => {
		frame = 0;
		if (!drag) return;
		let scrolled = false;
		const container = viewport.current;
		if (container) {
			const r = container.getBoundingClientRect();
			const edge = 24;
			const speed = (point: number, start: number, end: number) =>
				point < start + edge
					? -Math.min(18, (start + edge - point) / 2)
					: point > end - edge
						? Math.min(18, (point - end + edge) / 2)
						: 0;
			const dx = speed(drag.x, r.left, r.right);
			const dy = speed(drag.y, r.top, r.bottom);
			if (dx || dy) {
				const left = container.scrollLeft;
				const top = container.scrollTop;
				container.scrollBy(dx, dy);
				if (container.scrollLeft !== left || container.scrollTop !== top) {
					boxes = null;
					scrolled = true;
				}
			}
		}
		update();
		if (drag && scrolled && !frame) frame = win.requestAnimationFrame(tick);
	};
	doc.addEventListener(
		"pointerdown",
		(event) => {
			mousePointer = event.pointerType === "mouse";
			if (!mousePointer) reset();
		},
		{ signal },
	);
	doc.addEventListener(
		"mousedown",
		(event) => {
			reset();
			if (
				!mousePointer ||
				event.defaultPrevented ||
				event.button !== 0 ||
				event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				event.detail > 1
			)
				return;
			const target = event.target;
			if (!(target instanceof Element) || target.closest(interactive)) return;
			// Listen above all page layers, so a canvas or a non-interactive overlay is
			// just as selectable as the text layer. Viewer chrome remains independent.
			const onPage = [...layers].some((layer) =>
				layer.parentElement?.contains(target),
			);
			if (
				!onPage &&
				!(
					viewport.current === target ||
					(viewport.current?.contains(target) &&
						target.contains([...layers][0] ?? null))
				)
			)
				return;
			// Leave actual scrollbar presses to the browser.
			if (
				target instanceof HTMLElement &&
				/auto|scroll/.test(win.getComputedStyle(target).overflow)
			) {
				const r = target.getBoundingClientRect();
				const scrollbarX =
					((target.offsetWidth - target.clientWidth - target.clientLeft * 2) *
						r.width) /
					target.offsetWidth;
				const scrollbarY =
					((target.offsetHeight - target.clientHeight - target.clientTop * 2) *
						r.height) /
					target.offsetHeight;
				if (
					event.clientX >= r.right - scrollbarX ||
					event.clientY >= r.bottom - scrollbarY
				)
					return;
			}
			const focus = resolve(event.clientX, event.clientY);
			const selection = doc.getSelection();
			if (!focus || !selection) return;
			const anchor =
				event.shiftKey && contains(selection.anchorNode)
					? { node: selection.anchorNode!, offset: selection.anchorOffset }
					: focus;
			event.preventDefault();
			drag = { anchor, x: event.clientX, y: event.clientY };
			for (const layer of layers) layer.classList.add("selecting");
			update();
		},
		{ signal },
	);
	doc.addEventListener(
		"mousemove",
		(event) => {
			if (!drag) return;
			if (!(event.buttons & 1)) {
				reset();
				return;
			}
			event.preventDefault();
			drag.x = event.clientX;
			drag.y = event.clientY;
			update();
			if (!frame) frame = win.requestAnimationFrame(tick);
		},
		{ signal },
	);
	doc.addEventListener(
		"mouseup",
		(event) => {
			if (drag && event.button === 0) {
				drag.x = event.clientX;
				drag.y = event.clientY;
				update();
				reset();
			}
		},
		{ signal },
	);
	doc.addEventListener("scroll", invalidate, {
		signal,
		capture: true,
		passive: true,
	});
	win.addEventListener("resize", invalidate, { signal });
	win.addEventListener("blur", reset, { signal });
	doc.addEventListener("pointercancel", reset, { signal });
	doc.addEventListener(
		"keydown",
		(event) => {
			if (event.key === "Escape") reset();
		},
		{ signal },
	);

	return {
		add(layer: HTMLDivElement) {
			layers.add(layer);
			invalidate();
			return () => {
				layers.delete(layer);
				layer.classList.remove("selecting");
				invalidate();
				if (drag && layer.contains(drag.anchor.node)) reset();
				if (!layers.size) {
					reset();
					controller.abort();
					managers.delete(viewport);
				}
			};
		},
	};
}

const managers = new WeakMap<
	ViewportRef,
	ReturnType<typeof createSelectionManager>
>();

/** One mouse-selection controller per viewer, shared by its mounted pages. */
export function bindTextSelection(
	layer: HTMLDivElement,
	viewport: ViewportRef,
) {
	let manager = managers.get(viewport);
	if (!manager) {
		manager = createSelectionManager(viewport, layer.ownerDocument);
		managers.set(viewport, manager);
	}
	return manager.add(layer);
}
