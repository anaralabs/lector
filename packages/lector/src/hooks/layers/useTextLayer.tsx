import { useEffect, useRef } from "react";

import { usePdf } from "../../internal";
import { subscribeToViewportInvalidation } from "../../lib/viewport-invalidation";
import { usePDFPageNumber } from "../usePdfPageNumber";

// Add custom property declarations
interface TextLayerDivElement extends HTMLDivElement {
	_textSelectionBound?: boolean;
	_cleanupTextSelection?: () => void;
}

const createTextSelectionManager = () => {
	const textLayers = new Map<HTMLDivElement, HTMLElement>();
	let selectionChangeAbortController: AbortController | null = null;
	let isPointerDown = false;
	let prevRange: Range | null = null;
	let isFirefox: boolean | undefined;

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

				if (isFirefox === undefined) {
					const firstTextLayer = textLayers.keys().next().value;
					if (firstTextLayer) {
						isFirefox =
							getComputedStyle(firstTextLayer).getPropertyValue(
								"-moz-user-select",
							) === "none";
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

// Pages flicked past during a fast scroll mount and unmount within a few frames.
// Building their text layer (stream all text content from the pdf worker + lay
// out one span per glyph-run) is pure waste then — you can't select text you're
// flying past — and it's the dominant scroll cost on text-dense PDFs. Defer the
// build until the page has stayed mounted for this long; flown-past pages never
// build. Text selection / search work as soon as scrolling settles.
const TEXT_BUILD_IDLE_MS = 300;

// The text layer is fully transparent — it exists only for selection/search; the
// visible text is painted on the canvas below. So while scrolling we hide it to
// skip re-rasterizing every (transparent) span as the zoom-scaled page moves —
// the dominant remaining scroll cost on text-dense PDFs — and restore it this
// long after the last scroll event (i.e. once scrolling settles).
const TEXT_SCROLL_SETTLE_MS = 160;

export const useTextLayer = () => {
	const textContainerRef = useRef<TextLayerDivElement>(null);
	const textLayerRef = useRef<{
		cancel: () => void;
		render: () => Promise<void>;
	} | null>(null);

	const pageNumber = usePDFPageNumber();
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
	const viewportRef = usePdf((state) => state.viewportRef);

	useEffect(() => {
		const textContainer = textContainerRef.current;
		if (!textContainer) {
			return;
		}

		let isCancelled = false;

		const buildTimer = setTimeout(() => {
			if (isCancelled || textContainerRef.current !== textContainer) return;

			textContainer.innerHTML = "";
			if (textLayerRef.current) {
				textLayerRef.current.cancel();
				textLayerRef.current = null;
			}

			void import("pdfjs-dist/legacy/build/pdf.mjs")
				.then(({ TextLayer }) => {
					if (isCancelled || textContainerRef.current !== textContainer) return;

					const textLayer = new TextLayer({
						textContentSource: pdfPageProxy.streamTextContent(),
						container: textContainer,
						viewport: pdfPageProxy.getViewport({ scale: 1 }),
					});

					textLayerRef.current = textLayer;

					return textLayer.render();
				})
				.then(() => {
					if (isCancelled || textContainerRef.current !== textContainer) {
						return;
					}

					const endOfContent = document.createElement("div");
					endOfContent.className = "endOfContent";
					textContainer.appendChild(endOfContent);

					bindMouseEvents(textContainer, endOfContent);
				})
				.catch((error) => {
					if (error instanceof Error && error.name !== "AbortException") {
						console.error("TextLayer rendering error:", error);
					}
				});
		}, TEXT_BUILD_IDLE_MS);

		return () => {
			isCancelled = true;
			clearTimeout(buildTimer);

			if (textLayerRef.current) {
				textLayerRef.current.cancel();
				textLayerRef.current = null;
			}

			if (textContainer?._cleanupTextSelection) {
				textContainer._cleanupTextSelection();
				delete textContainer._cleanupTextSelection;
			}
		};
	}, [pdfPageProxy.streamTextContent, pdfPageProxy.getViewport]);

	// Hide the (transparent) text layer while scrolling so its spans aren't
	// repainted as the page moves, and restore it once scrolling settles.
	useEffect(() => {
		const textContainer = textContainerRef.current;
		const viewport = viewportRef?.current;
		if (!textContainer || !viewport) return;

		let settleTimer: ReturnType<typeof setTimeout> | null = null;
		// `selecting` is true only while a drag-select is actively extending the
		// selection: a pointer is held AND `selectionchange` has fired since it
		// went down. We keep the layer visible only then, so it isn't torn out
		// from under a drag-select that auto-scrolls. Everything else hides —
		// wheel, trackpad, AND touch scrolling (a touch scroll holds the pointer
		// down but doesn't change the selection, even if a stale one lingers).
		let pointerDown = false;
		let selecting = false;

		const show = () => {
			textContainer.style.visibility = "";
		};

		const onScroll = () => {
			if (selecting) return;
			textContainer.style.visibility = "hidden";
			if (settleTimer) clearTimeout(settleTimer);
			settleTimer = setTimeout(show, TEXT_SCROLL_SETTLE_MS);
		};

		const onPointerDown = () => {
			pointerDown = true;
			selecting = false;
			// Restore immediately so a click can start a selection on the visible
			// text even within the post-scroll settle window.
			if (settleTimer) {
				clearTimeout(settleTimer);
				settleTimer = null;
			}
			show();
		};
		const onSelectionChange = () => {
			if (pointerDown) selecting = true;
		};
		// pointerup can be missed if the pointer is released off-window, so also
		// clear on pointercancel and window blur — otherwise the flag could stick
		// and disable hiding for good.
		const clearPointer = () => {
			pointerDown = false;
			selecting = false;
		};

		const unsubscribe = subscribeToViewportInvalidation(viewport, onScroll);
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("pointerup", clearPointer, true);
		document.addEventListener("pointercancel", clearPointer, true);
		document.addEventListener("selectionchange", onSelectionChange);
		window.addEventListener("blur", clearPointer);

		return () => {
			unsubscribe();
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("pointerup", clearPointer, true);
			document.removeEventListener("pointercancel", clearPointer, true);
			document.removeEventListener("selectionchange", onSelectionChange);
			window.removeEventListener("blur", clearPointer);
			if (settleTimer) clearTimeout(settleTimer);
			show();
		};
	}, [viewportRef]);

	return {
		textContainerRef,
		pageNumber: pdfPageProxy.pageNumber,
	};
};
