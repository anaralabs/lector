type TextNodeRect = { rect: DOMRect; element: Element | null };

/**
 * Per-text-node client rects for a selection. Avoids the block-level rects
 * that `range.getClientRects()` returns for `.textLayer` / page wrappers,
 * which would render as full-page highlights on multi-page selections.
 */
export const getTextNodeClientRects = (range: Range): TextNodeRect[] => {
	const root = range.commonAncestorContainer;
	const ownerDoc = root.ownerDocument ?? document;

	if (root.nodeType === Node.TEXT_NODE) {
		const parentElement = (root as Text).parentElement;
		return Array.from(range.getClientRects()).map((rect) => ({
			rect,
			element: parentElement,
		}));
	}

	const walker = ownerDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			if (!node.nodeValue || node.nodeValue.length === 0) {
				return NodeFilter.FILTER_REJECT;
			}
			try {
				return range.intersectsNode(node)
					? NodeFilter.FILTER_ACCEPT
					: NodeFilter.FILTER_REJECT;
			} catch {
				return NodeFilter.FILTER_REJECT;
			}
		},
	});

	const results: TextNodeRect[] = [];
	let current = walker.nextNode();
	while (current) {
		const textNode = current as Text;
		const parentElement = textNode.parentElement;
		const length = textNode.nodeValue?.length ?? 0;
		const isStartNode = textNode === range.startContainer;
		const isEndNode = textNode === range.endContainer;
		const start = isStartNode ? range.startOffset : 0;
		const end = isEndNode ? range.endOffset : length;
		if (end > start) {
			const sub = ownerDoc.createRange();
			try {
				sub.setStart(textNode, start);
				sub.setEnd(textNode, end);
				const subRects = sub.getClientRects();
				for (let i = 0; i < subRects.length; i++) {
					const r = subRects[i];
					if (r) results.push({ rect: r, element: parentElement });
				}
			} catch {
			} finally {
				sub.detach?.();
			}
		}
		current = walker.nextNode();
	}

	return results;
};

type Rect = { left: number; top: number; width: number; height: number };

// Compare the original text runs, so a growing bounding box cannot bridge
// unrelated lines or columns. PDF word/sentence spaces can exist only as gaps
// between positioned runs. Allow up to half a text-run height to include those
// spaces (including justified text), while leaving wider column gutters open.
const connected = (a: Rect, b: Rect) => {
	const overlap =
		Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
	const gap =
		Math.max(a.left, b.left) - Math.min(a.left + a.width, b.left + b.width);
	return (
		overlap >= Math.min(a.height, b.height) / 2 &&
		gap <= Math.min(a.height, b.height) * 0.5
	);
};

export const mergeTextRuns = <T extends Rect>(rects: T[]): T[] => {
	const groups: T[][] = [];
	for (const rect of rects) {
		const group = [rect];
		for (let i = groups.length - 1; i >= 0; i--) {
			if (groups[i]!.some((member) => connected(member, rect))) {
				group.push(...groups[i]!);
				groups.splice(i, 1);
			}
		}
		groups.push(group);
	}
	return groups.map((group) => {
		const left = Math.min(...group.map((rect) => rect.left));
		const top = Math.min(...group.map((rect) => rect.top));
		return {
			...group[0]!,
			left,
			top,
			width: Math.max(...group.map((rect) => rect.left + rect.width)) - left,
			height: Math.max(...group.map((rect) => rect.top + rect.height)) - top,
		};
	});
};
