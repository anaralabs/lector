import {
	normalizeSelectionText,
	type SelectionTextOptions,
} from "./text-normalization";

function textLayer(node: Node) {
	const element =
		node.nodeType === Node.ELEMENT_NODE
			? (node as Element)
			: node.parentElement;
	return element?.closest<HTMLElement>(".textLayer[data-page-number]") ?? null;
}

/**
 * Read mounted PDF text in DOM/PDF.js order, including explicit line breaks.
 * Null means the selection isn't wholly owned by this viewer or skips pages.
 * Never reorder columns/RTL runs heuristically or silently omit unmounted pages.
 */
export function getPdfSelectionText(
	selection: Selection | null,
	container: HTMLElement,
	options: SelectionTextOptions = {},
): string | null {
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
		return null;
	const range = selection.getRangeAt(0);
	const first = textLayer(range.startContainer);
	const last = textLayer(range.endContainer);
	if (
		!first ||
		!last ||
		!container.contains(first) ||
		!container.contains(last)
	)
		return null;
	const layers = [
		...container.querySelectorAll<HTMLElement>(".textLayer[data-page-number]"),
	].filter((layer) => range.intersectsNode(layer));
	let previousPage: number | undefined;
	for (const layer of layers) {
		const page = Number(layer.dataset.pageNumber);
		if (
			!Number.isInteger(page) ||
			page < 1 ||
			(previousPage !== undefined && page !== previousPage + 1)
		)
			return null;
		previousPage = page;
	}
	const selectedLayers = new Set(layers);
	const root = range.commonAncestorContainer;
	const walker = container.ownerDocument.createTreeWalker(
		root,
		NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
		{
			acceptNode(node) {
				if (
					node.nodeType !== Node.TEXT_NODE &&
					(node as Element).tagName !== "BR"
				)
					return NodeFilter.FILTER_SKIP;
				const layer = textLayer(node);
				return layer && selectedLayers.has(layer) && range.intersectsNode(node)
					? NodeFilter.FILTER_ACCEPT
					: NodeFilter.FILTER_SKIP;
			},
		},
	);
	const chunks: string[] = [];
	let previousLayer: HTMLElement | null = null;
	let node: Node | null =
		root.nodeType === Node.TEXT_NODE ? root : walker.nextNode();
	while (node) {
		const layer = textLayer(node)!;
		const start = node === range.startContainer ? range.startOffset : 0;
		const end =
			node === range.endContainer
				? range.endOffset
				: (node.textContent?.length ?? 0);
		const text =
			node.nodeType === Node.TEXT_NODE
				? node.textContent!.slice(start, end)
				: "\n";
		if (text) {
			if (previousLayer && previousLayer !== layer) chunks.push("\n\n");
			chunks.push(text);
			previousLayer = layer;
		}
		node = walker.nextNode();
	}
	return normalizeSelectionText(chunks.join(""), options);
}

type CopyOptions = false | SelectionTextOptions;
type CopyRegistration = { container: HTMLElement; options: () => CopyOptions };
const documents = new WeakMap<
	Document,
	{
		registrations: Set<CopyRegistration>;
		listener: (event: ClipboardEvent) => void;
	}
>();

/** One copy listener per owner document; no work runs during scroll or render. */
export function registerPdfCopy(
	container: HTMLElement,
	options: () => CopyOptions,
) {
	const owner = container.ownerDocument;
	let binding = documents.get(owner);
	if (!binding) {
		const registrations = new Set<CopyRegistration>();
		const listener = (event: ClipboardEvent) => {
			if (event.defaultPrevented || !event.clipboardData) return;
			const target = event.target;
			if (
				target instanceof Element &&
				target.closest(
					'input, textarea, [contenteditable]:not([contenteditable="false"])',
				)
			)
				return;
			for (const registration of registrations) {
				const settings = registration.options();
				if (settings === false) continue;
				const text = getPdfSelectionText(
					owner.getSelection(),
					registration.container,
					settings,
				);
				if (text === null) continue;
				event.clipboardData.setData("text/plain", text);
				event.preventDefault();
				break;
			}
		};
		binding = { registrations, listener };
		documents.set(owner, binding);
		owner.addEventListener("copy", listener);
	}
	const registration = { container, options };
	binding.registrations.add(registration);
	return () => {
		binding.registrations.delete(registration);
		if (!binding.registrations.size) {
			owner.removeEventListener("copy", binding.listener);
			documents.delete(owner);
		}
	};
}
