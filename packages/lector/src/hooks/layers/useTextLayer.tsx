import { useEffect, useRef } from "react";

import { PDFStore, usePdf } from "../../internal";
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

// The viewport ref is assigned by a parent effect (after child effects), so on
// first mount the scroll subscription retries on rAF. A mounted page implies
// the viewport div is already committed (pages render inside it), so this
// normally succeeds on the first retry — the generous cap only exists so a
// non-lector integration without a viewport doesn't spin a rAF loop forever.
const VIEWPORT_ATTACH_MAX_FRAMES = 300;

export const useTextLayer = () => {
	const textContainerRef = useRef<TextLayerDivElement>(null);
	const textLayerRef = useRef<{
		cancel: () => void;
		render: () => Promise<void>;
	} | null>(null);

	const pageNumber = usePDFPageNumber();
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
	const viewportRef = usePdf((state) => state.viewportRef);
	const store = PDFStore.useContext();

	useEffect(() => {
		const textContainer = textContainerRef.current;
		if (!textContainer) {
			return;
		}

		let isCancelled = false;
		let buildTimer: ReturnType<typeof setTimeout> | null = null;
		let unsubscribe: (() => void) | null = null;

		// Building the text layer streams the page text from the pdf worker and
		// measures every span (`ctx.measureText`) — a 100ms+ main-thread burst on
		// dense pages that lands mid-scroll as the virtualizer mounts pages, and
		// the user can't select text they're flying past anyway. So debounce the
		// build against viewport scrolls: every scroll event restarts the timer
		// (cancelling an in-flight build, which would otherwise keep running on
		// the scroll path), and the build runs exactly TEXT_BUILD_IDLE_MS after
		// the last scroll (mirrors the visibility gating below). Once a build has
		// COMPLETED, further scrolls are no-ops.
		let built = false;
		let building = false;
		// Bumped to abandon a cancelled build's promise chain so it can't mark
		// `built` or touch the container after a newer build has started.
		let buildGen = 0;

		const build = () => {
			building = true;
			const gen = ++buildGen;

			textContainer.innerHTML = "";
			if (textLayerRef.current) {
				textLayerRef.current.cancel();
				textLayerRef.current = null;
			}

			void import("pdfjs-dist/legacy/build/pdf.mjs")
				.then(({ TextLayer }) => {
					if (
						isCancelled ||
						gen !== buildGen ||
						textContainerRef.current !== textContainer
					)
						return;

					const textLayer = new TextLayer({
						textContentSource: pdfPageProxy.streamTextContent(),
						container: textContainer,
						viewport: pdfPageProxy.getViewport({ scale: 1 }),
					});

					textLayerRef.current = textLayer;

					return textLayer.render();
				})
				.then(() => {
					if (
						isCancelled ||
						gen !== buildGen ||
						textContainerRef.current !== textContainer
					) {
						return;
					}

					const endOfContent = document.createElement("div");
					endOfContent.className = "endOfContent";
					textContainer.appendChild(endOfContent);

					bindMouseEvents(textContainer, endOfContent);

					built = true;
					building = false;
					// The build is final — drop the scroll subscription so settled
					// pages don't run a no-op callback on every scroll.
					unsubscribe?.();
					unsubscribe = null;
				})
				.catch((error) => {
					if (gen === buildGen) building = false;
					if (error instanceof Error && error.name !== "AbortException") {
						console.error("TextLayer rendering error:", error);
					}
				});
		};

		const schedule = () => {
			if (built) return;
			if (building) {
				// A scroll started mid-build: stop the streaming render so its
				// span-measuring work doesn't land on the scroll path, and rebuild
				// from scratch once the viewport is idle again. Clear the container
				// too so a partially-rendered text layer can't be selected/copied
				// during the debounce window.
				buildGen++;
				building = false;
				if (textLayerRef.current) {
					textLayerRef.current.cancel();
					textLayerRef.current = null;
				}
				textContainer.innerHTML = "";
			}
			if (buildTimer) clearTimeout(buildTimer);
			buildTimer = setTimeout(() => {
				buildTimer = null;
				if (isCancelled || textContainerRef.current !== textContainer) return;
				build();
			}, TEXT_BUILD_IDLE_MS);
		};

		// `viewportRef.current` is assigned in a PARENT effect
		// (useViewportContainer), and React runs child effects first — so on the
		// initial mount it can still be null here. Retry on the next frame until
		// the viewport exists (normally one frame) so initially-mounted pages get
		// the debounce too; give up after ~1s so an integration without lector's
		// viewport doesn't spin a rAF loop forever (the fixed timer still runs).
		let attachRaf: number | null = null;
		let attachAttempts = 0;
		const attachScrollSubscription = () => {
			attachRaf = null;
			const scrollViewport = viewportRef?.current;
			if (!scrollViewport) {
				if (++attachAttempts > VIEWPORT_ATTACH_MAX_FRAMES) return;
				attachRaf = requestAnimationFrame(attachScrollSubscription);
				return;
			}
			unsubscribe = subscribeToViewportInvalidation(scrollViewport, schedule);
		};
		attachScrollSubscription();
		schedule();

		return () => {
			isCancelled = true;
			if (buildTimer) clearTimeout(buildTimer);
			if (attachRaf !== null) cancelAnimationFrame(attachRaf);
			unsubscribe?.();

			if (textLayerRef.current) {
				textLayerRef.current.cancel();
				textLayerRef.current = null;
			}

			if (textContainer?._cleanupTextSelection) {
				textContainer._cleanupTextSelection();
				delete textContainer._cleanupTextSelection;
			}
		};
	}, [pdfPageProxy.streamTextContent, pdfPageProxy.getViewport, viewportRef]);

	// Hide the (transparent) text layer while scrolling so its spans aren't
	// repainted as the page moves, and restore it once scrolling settles.
	useEffect(() => {
		const textContainer = textContainerRef.current;
		if (!textContainer) return;

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

		const restoreWhenSettled = () => {
			settleTimer = null;
			// A pinch can outlast the settle window with the zoom value clamped
			// (no further zoom changes to re-arm the timer) — stay hidden until
			// the gesture actually ends.
			if (store.getState().isPinching) {
				settleTimer = setTimeout(restoreWhenSettled, TEXT_SCROLL_SETTLE_MS);
				return;
			}
			show();
		};

		const hideAndDebounce = () => {
			// Never hide under an active drag-select (scroll-driven or
			// zoom-driven) — the guard lives here so every hide trigger
			// respects it.
			if (selecting) return;
			textContainer.style.visibility = "hidden";
			if (settleTimer) clearTimeout(settleTimer);
			settleTimer = setTimeout(restoreWhenSettled, TEXT_SCROLL_SETTLE_MS);
		};

		const onScroll = () => {
			hideAndDebounce();
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

		// Same mount-order caveat as the build effect above: the viewport ref is
		// assigned by a parent effect, so retry (bounded) until it exists.
		let unsubscribe: (() => void) | null = null;
		let attachRaf: number | null = null;
		let attachAttempts = 0;
		const attachScrollSubscription = () => {
			attachRaf = null;
			const scrollViewport = viewportRef?.current;
			if (!scrollViewport) {
				if (++attachAttempts > VIEWPORT_ATTACH_MAX_FRAMES) return;
				attachRaf = requestAnimationFrame(attachScrollSubscription);
				return;
			}
			unsubscribe = subscribeToViewportInvalidation(scrollViewport, onScroll);
		};
		attachScrollSubscription();

		// Zooming re-rasterizes every (transparent) span under the animating CSS
		// transform, just like scrolling moves them — hide during zoom changes
		// and active pinches too. Scroll re-anchoring during zoom only fires
		// scroll events incidentally, so the scroll subscription alone misses
		// most of the gesture.
		const initialState = store.getState();
		let prevZoom = initialState.zoom;
		let prevPinching = initialState.isPinching;
		// `subscribe` doesn't replay the current state — a layer mounting in the
		// middle of an ongoing pinch must start hidden or it defeats the gating.
		if (prevPinching) hideAndDebounce();
		const unsubscribeStore = store.subscribe(
			(state: ReturnType<typeof store.getState>) => {
				const zoomChanged = state.zoom !== prevZoom;
				const pinchStarted = state.isPinching && !prevPinching;
				prevZoom = state.zoom;
				prevPinching = state.isPinching;
				if (zoomChanged || pinchStarted) hideAndDebounce();
			},
		);

		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("pointerup", clearPointer, true);
		document.addEventListener("pointercancel", clearPointer, true);
		document.addEventListener("selectionchange", onSelectionChange);
		window.addEventListener("blur", clearPointer);

		return () => {
			if (attachRaf !== null) cancelAnimationFrame(attachRaf);
			unsubscribe?.();
			unsubscribeStore();
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("pointerup", clearPointer, true);
			document.removeEventListener("pointercancel", clearPointer, true);
			document.removeEventListener("selectionchange", onSelectionChange);
			window.removeEventListener("blur", clearPointer);
			if (settleTimer) clearTimeout(settleTimer);
			show();
		};
	}, [viewportRef, store]);

	return {
		textContainerRef,
		pageNumber: pdfPageProxy.pageNumber,
	};
};
