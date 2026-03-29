import { useEffect, useMemo, useRef, useState } from "react";

import { usePdf } from "../../internal";
import { loadPdfJs } from "../../lib/pdfjs";
import { getTextLayerPageModel } from "../../lib/text-layer/model";
import { ensureTextLayerStyles } from "../../lib/text-layer/styles";
import type { TextLayerRenderMode } from "../../lib/text-layer/types";
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

export type TextLayerModeOverride = "auto" | "pretext" | "pdfjs";

export const useTextLayer = ({
	mode = "auto",
}: {
	mode?: TextLayerModeOverride;
} = {}) => {
	const textContainerRef = useRef<TextLayerDivElement>(null);
	const textLayerRef = useRef<{
		cancel: () => void;
		render: () => Promise<void>;
	} | null>(null);
	const isRenderingRef = useRef(false);
	const [renderMode, setRenderMode] = useState<TextLayerRenderMode>("pretext");
	const [fallbackReason, setFallbackReason] = useState<string | null>(null);

	const pageNumber = usePDFPageNumber();
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
	const setTextLayerModel = usePdf((state) => state.setTextLayerModel);
	const effectiveMode = useMemo(() => mode ?? "auto", [mode]);

	useEffect(() => {
		ensureTextLayerStyles();
	}, []);

	useEffect(() => {
		const textContainer = textContainerRef.current;
		if (!textContainer || isRenderingRef.current) {
			return;
		}

		let isCancelled = false;

		isRenderingRef.current = true;

		textContainer.innerHTML = "";

		if (textLayerRef.current) {
			textLayerRef.current.cancel();
			textLayerRef.current = null;
		}

		const renderCustomTextLayer = async () => {
			const model = await getTextLayerPageModel(pdfPageProxy);
			if (isCancelled || textContainerRef.current !== textContainer) {
				return false;
			}

			setTextLayerModel(model);
			const shouldForcePdfjs = effectiveMode === "pdfjs";
			const shouldForcePretext = effectiveMode === "pretext";
			const shouldUseCustomRenderer = shouldForcePretext
				? true
				: shouldForcePdfjs
					? false
					: model.canUseCustomRenderer;

			if (shouldForcePdfjs) {
				setRenderMode("pdfjs");
				setFallbackReason("forced-pdfjs");
				return false;
			}

			setRenderMode("pretext");
			setFallbackReason(
				shouldForcePretext
					? null
					: model.canUseCustomRenderer
						? null
						: model.fallbackReason,
			);

			if (!shouldUseCustomRenderer) {
				return false;
			}

			for (const run of model.runs) {
				if (!shouldForcePretext && !run.canUseCustomRenderer) {
					return false;
				}

				if (!run.rawText) {
					if (run.hasEOL) {
						const br = document.createElement("br");
						br.setAttribute("role", "presentation");
						textContainer.appendChild(br);
					}
					continue;
				}

				const span = document.createElement("span");
				span.setAttribute("role", "presentation");
				span.textContent = run.rawText;
				span.dir = run.dir;

				const style = span.style;
				style.left = `${((run.left / model.viewport.width) * 100).toFixed(2)}%`;
				style.top = `${((run.top / model.viewport.height) * 100).toFixed(2)}%`;
				style.setProperty("--font-height", `${run.fontSize.toFixed(2)}px`);
				style.fontFamily = run.fontFamily;
				style.fontSize = "calc(var(--text-scale-factor) * var(--font-height))";
				style.setProperty("--scale-x", "1");
				style.setProperty("--rotate", `${run.angle}deg`);

				textContainer.appendChild(span);

				const actualWidth = span.getBoundingClientRect().width;
				if (actualWidth > 0 && run.width > 0) {
					style.setProperty("--scale-x", `${run.width / actualWidth}`);
				} else {
					style.setProperty("--scale-x", `${run.scaleX}`);
				}

				if (run.hasEOL) {
					const br = document.createElement("br");
					br.setAttribute("role", "presentation");
					textContainer.appendChild(br);
				}
			}

			return true;
		};

		void renderCustomTextLayer()
			.then((rendered) => {
				if (
					rendered ||
					isCancelled ||
					textContainerRef.current !== textContainer
				) {
					return;
				}

				return loadPdfJs().then(({ TextLayer }) => {
					if (isCancelled || textContainerRef.current !== textContainer) {
						return;
					}

					setRenderMode(effectiveMode === "pdfjs" ? "pdfjs" : "pdfjs-fallback");
					setFallbackReason(
						(reason) =>
							reason ??
							(effectiveMode === "pdfjs" ? "forced-pdfjs" : "runtime-fallback"),
					);

					const textLayer = new TextLayer({
						textContentSource: pdfPageProxy.streamTextContent(),
						container: textContainer,
						viewport: pdfPageProxy.getViewport({ scale: 1 }),
					});

					textLayerRef.current = textLayer;

					return textLayer.render();
				});
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
				if (error.name !== "AbortException") {
					console.error("TextLayer rendering error:", error);
				}
			})
			.finally(() => {
				isRenderingRef.current = false;
			});

		return () => {
			isCancelled = true;
			isRenderingRef.current = false;

			if (textLayerRef.current) {
				textLayerRef.current.cancel();
				textLayerRef.current = null;
			}

			if (textContainer?._cleanupTextSelection) {
				textContainer._cleanupTextSelection();
				delete textContainer._cleanupTextSelection;
			}
		};
	}, [effectiveMode, pdfPageProxy, setTextLayerModel]);

	return {
		textContainerRef,
		pageNumber: pdfPageProxy.pageNumber,
		renderMode,
		fallbackReason,
		requestedMode: effectiveMode,
	};
};
