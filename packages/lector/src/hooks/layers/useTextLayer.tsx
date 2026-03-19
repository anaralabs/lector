import type { PDFPageProxy } from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import { useEffect, useRef } from "react";

import { usePdf } from "../../internal";
import { usePDFPageNumber } from "../usePdfPageNumber";

interface TextLayerDivElement extends HTMLDivElement {
	_textSelectionBound?: boolean;
	_cleanupTextSelection?: () => void;
}

// Cache rendered text layer DOM across virtualizer mount/unmount cycles.
// Keyed on PDFPageProxy so entries are GC'd when the document is released.
const textLayerDOMCache = new WeakMap<PDFPageProxy, DocumentFragment>();

const createTextSelectionManager = () => {
	const textLayers = new Map<HTMLDivElement, HTMLElement>();
	let selectionChangeAbortController: AbortController | null = null;
	let isPointerDown = false;
	let prevRange: Range | null = null;
	let isFirefox: boolean | null = null;

	const detectFirefox = (el: HTMLDivElement) => {
		if (isFirefox !== null) return;
		isFirefox =
			getComputedStyle(el).getPropertyValue("-moz-user-select") === "none";
	};

	const removeGlobalSelectionListener = (textLayerDiv: HTMLDivElement) => {
		textLayers.delete(textLayerDiv);
		if (textLayers.size === 0) {
			selectionChangeAbortController?.abort();
			selectionChangeAbortController = null;
		}
	};

	const enableGlobalSelectionListener = () => {
		if (selectionChangeAbortController) {
			return;
		}

		selectionChangeAbortController = new AbortController();
		const { signal } = selectionChangeAbortController;

		const reset = (endDiv: HTMLElement, textLayer: HTMLDivElement) => {
			if (endDiv.parentNode !== textLayer) {
				textLayer.appendChild(endDiv);
			}
			endDiv.style.width = "";
			endDiv.style.height = "";
			textLayer.classList.remove("selecting");
		};

		document.addEventListener(
			"pointerdown",
			() => {
				isPointerDown = true;
			},
			{ signal },
		);

		document.addEventListener(
			"pointerup",
			() => {
				isPointerDown = false;
				textLayers.forEach(reset);
			},
			{ signal },
		);

		window.addEventListener(
			"blur",
			() => {
				isPointerDown = false;
				textLayers.forEach(reset);
			},
			{ signal },
		);

		document.addEventListener(
			"keyup",
			() => {
				if (!isPointerDown) {
					textLayers.forEach(reset);
				}
			},
			{ signal },
		);

		document.addEventListener(
			"selectionchange",
			() => {
				const selection = document.getSelection();
				if (!selection || selection.rangeCount === 0) {
					textLayers.forEach(reset);
					return;
				}

				const activeTextLayers = new Set<HTMLDivElement>();
				for (let i = 0; i < selection.rangeCount; i++) {
					const range = selection.getRangeAt(i);
					for (const textLayerDiv of textLayers.keys()) {
						if (
							!activeTextLayers.has(textLayerDiv) &&
							range.intersectsNode(textLayerDiv)
						) {
							activeTextLayers.add(textLayerDiv);
						}
					}
				}

				for (const [textLayerDiv, endDiv] of textLayers) {
					if (activeTextLayers.has(textLayerDiv)) {
						textLayerDiv.classList.add("selecting");
					} else {
						reset(endDiv, textLayerDiv);
					}
				}

				if (isFirefox) {
					return;
				}

				try {
					const range = selection.getRangeAt(0);
					const modifyStart =
						prevRange &&
						(range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
							range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);

					let anchor = modifyStart ? range.startContainer : range.endContainer;
					if (anchor.nodeType === Node.TEXT_NODE) {
						anchor = anchor.parentNode as HTMLElement;
					}

					const parentTextLayer = anchor.parentElement?.closest(
						".textLayer",
					) as HTMLDivElement;
					const endDiv = textLayers.get(parentTextLayer);

					if (endDiv && parentTextLayer) {
						endDiv.style.width = parentTextLayer.style.width;
						endDiv.style.height = parentTextLayer.style.height;
						const insertTarget = modifyStart ? anchor : anchor.nextSibling;
						if (anchor.parentElement && insertTarget) {
							anchor.parentElement.insertBefore(endDiv, insertTarget);
						}
					}

					prevRange = range.cloneRange();
				} catch {
					// ignore
				}
			},
			{ signal },
		);
	};

	const bindMouseEvents = (
		textLayerDiv: TextLayerDivElement,
		endOfContent: HTMLElement,
	) => {
		if (textLayerDiv._textSelectionBound) {
			return;
		}
		textLayerDiv._textSelectionBound = true;

		textLayers.set(textLayerDiv, endOfContent);
		enableGlobalSelectionListener();
		detectFirefox(textLayerDiv);

		const handleMouseDown = () => {
			textLayerDiv.classList.add("selecting");
		};

		textLayerDiv.addEventListener("mousedown", handleMouseDown);
		textLayerDiv._cleanupTextSelection = () => {
			textLayerDiv.removeEventListener("mousedown", handleMouseDown);
			removeGlobalSelectionListener(textLayerDiv);
			delete textLayerDiv._textSelectionBound;
		};
	};

	return bindMouseEvents;
};

const bindMouseEvents = createTextSelectionManager();

const scheduleIdle =
	typeof requestIdleCallback === "function"
		? requestIdleCallback
		: (cb: () => void) => setTimeout(cb, 16) as unknown as number;
const cancelIdle =
	typeof cancelIdleCallback === "function"
		? cancelIdleCallback
		: (id: number) => clearTimeout(id);

export const useTextLayer = () => {
	const textContainerRef = useRef<TextLayerDivElement>(null);
	const textLayerRef = useRef<TextLayer | null>(null);
	const isRenderingRef = useRef(false);
	const idleHandleRef = useRef(0);

	const pageNumber = usePDFPageNumber();
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));

	useEffect(() => {
		const textContainer = textContainerRef.current;
		if (!textContainer) return;

		const cached = textLayerDOMCache.get(pdfPageProxy);
		if (cached) {
			textLayerDOMCache.delete(pdfPageProxy);
			textContainer.appendChild(cached);

			const endOfContent = textContainer.querySelector(
				".endOfContent",
			) as HTMLElement;
			if (endOfContent) {
				bindMouseEvents(textContainer, endOfContent);
			}
		} else if (!isRenderingRef.current) {
			// Defer fresh text layer rendering until the browser is idle.
			// During fast scroll the component unmounts before the callback
			// fires, so the expensive span creation + measurement is skipped
			// for pages that are only briefly in the virtualizer window.
			idleHandleRef.current = scheduleIdle(() => {
				if (!textContainerRef.current) return;
				isRenderingRef.current = true;
				textContainer.replaceChildren();

				if (textLayerRef.current) {
					textLayerRef.current.cancel();
					textLayerRef.current = null;
				}

				const textLayer = new TextLayer({
					textContentSource: pdfPageProxy.streamTextContent(),
					container: textContainer,
					viewport: pdfPageProxy.getViewport({ scale: 1 }),
				});

				textLayerRef.current = textLayer;

				textLayer
					.render()
					.then(() => {
						if (textLayerRef.current === textLayer && textContainer) {
							const endOfContent = document.createElement("div");
							endOfContent.className = "endOfContent";
							textContainer.appendChild(endOfContent);

							bindMouseEvents(textContainer, endOfContent);
						}
					})
					.catch((error) => {
						if (error.name !== "AbortException") {
							console.error("TextLayer rendering error:", error);
						}
					})
					.finally(() => {
						isRenderingRef.current = false;
					});
			});
		}

		return () => {
			cancelIdle(idleHandleRef.current);

			if (isRenderingRef.current) {
				isRenderingRef.current = false;
				if (textLayerRef.current) {
					textLayerRef.current.cancel();
					textLayerRef.current = null;
				}
			} else if (textContainer.childNodes.length > 0) {
				const fragment = document.createDocumentFragment();
				while (textContainer.firstChild) {
					fragment.appendChild(textContainer.firstChild);
				}
				textLayerDOMCache.set(pdfPageProxy, fragment);

				if (textLayerRef.current) {
					textLayerRef.current.cancel();
					textLayerRef.current = null;
				}
			}

			if (textContainer._cleanupTextSelection) {
				textContainer._cleanupTextSelection();
				delete textContainer._cleanupTextSelection;
			}
		};
	}, [pdfPageProxy]);

	return {
		textContainerRef,
		pageNumber: pdfPageProxy.pageNumber,
	};
};
