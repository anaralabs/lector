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
