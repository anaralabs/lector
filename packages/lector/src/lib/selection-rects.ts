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
export const connected = (a: Rect, b: Rect) => {
	const overlap =
		Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
	const gap =
		Math.max(a.left, b.left) - Math.min(a.left + a.width, b.left + b.width);
	return (
		overlap >= Math.min(a.height, b.height) / 2 &&
		gap <= Math.min(a.height, b.height) * 0.5
	);
};

type Group<T> = {
	members: T[];
	left: number;
	top: number;
	right: number;
	bottom: number;
};

export const mergeTextRuns = <T extends Rect>(rects: T[]): T[] => {
	const groups: Group<T>[] = [];
	for (const rect of rects) {
		const group: Group<T> = {
			members: [rect],
			left: rect.left,
			top: rect.top,
			right: rect.left + rect.width,
			bottom: rect.top + rect.height,
		};
		// connected() needs vertical overlap and a gap of at most half the shorter
		// height, so a group whose own box is already out of reach holds no match.
		const reach = rect.height * 0.5;
		for (let i = groups.length - 1; i >= 0; i--) {
			const other = groups[i]!;
			if (
				rect.top > other.bottom ||
				rect.top + rect.height < other.top ||
				rect.left > other.right + reach ||
				rect.left + rect.width < other.left - reach
			)
				continue;
			if (other.members.some((member) => connected(member, rect))) {
				group.members.push(...other.members);
				group.left = Math.min(group.left, other.left);
				group.top = Math.min(group.top, other.top);
				group.right = Math.max(group.right, other.right);
				group.bottom = Math.max(group.bottom, other.bottom);
				groups.splice(i, 1);
			}
		}
		groups.push(group);
	}
	return groups.map(({ members, left, top, right, bottom }) => ({
		...members[0]!,
		left,
		top,
		width: right - left,
		height: bottom - top,
	}));
};
