import type { PageViewport } from "pdfjs-dist";
import { useEffect, useMemo, useRef } from "react";

import { usePdf } from "../../internal";
import { ensureAnnotationLayerStyles } from "../../lib/annotation-layer-styles";
import { usePdfJump } from "../pages/usePdfJump";
import { usePDFLinkService } from "../usePDFLinkService";
import { usePDFPageNumber } from "../usePdfPageNumber";
import { useVisibility } from "../useVisibility";

export interface AnnotationLayerParams {
	/**
	 * Whether to render forms.
	 */
	renderForms?: boolean;

	/**
	 * Whether external links are enabled.
	 * If false, external links will not open.
	 * @default true
	 */
	externalLinksEnabled?: boolean;

	/**
	 * Options to pass to the jumpToPage function when navigating.
	 * See usePdfJump hook for available options.
	 * @default { behavior: "smooth", align: "start" }
	 */
	jumpOptions?: Parameters<ReturnType<typeof usePdfJump>["jumpToPage"]>[1];
}

// Distance of an explicit destination from the top of its page, in scale-1
// viewport pixels (the coordinate space the virtualizer scrolls in). Returns
// null when the destination carries no usable position, so callers can fall
// back to a whole-page jump. Exported for tests.
export const getDestinationScrollTop = (
	viewport: PageViewport | undefined,
	explicitDest?: unknown[],
): number | null => {
	if (!viewport || !explicitDest) return null;

	const destType = explicitDest[1];
	const destName =
		destType && typeof destType === "object" && "name" in destType
			? (destType as { name?: unknown }).name
			: null;

	// PDF destination syntax: [pageRef, {name}, ...args] with args in PDF
	// user-space units (origin at the bottom-left of the page).
	let x: unknown = null;
	let y: unknown = null;
	switch (destName) {
		case "XYZ":
			x = explicitDest[2];
			y = explicitDest[3];
			break;
		case "FitH":
		case "FitBH":
			y = explicitDest[2];
			break;
		case "FitV":
		case "FitBV":
			x = explicitDest[2];
			break;
		case "FitR":
			x = explicitDest[2];
			y = explicitDest[5];
			break;
		default:
			return null;
	}

	// Viewport Y comes from PDF y on upright pages and from PDF x on
	// sideways-rotated ones; without that coordinate the destination cannot
	// be positioned vertically.
	const sideways = viewport.rotation % 180 !== 0;
	if (typeof (sideways ? x : y) !== "number") return null;

	const [, top] = viewport.convertToViewportPoint(
		typeof x === "number" ? x : 0,
		typeof y === "number" ? y : 0,
	);
	if (typeof top !== "number" || Number.isNaN(top)) return null;

	return Math.min(Math.max(top, 0), viewport.height);
};

const defaultAnnotationLayerParams = {
	renderForms: true,
	externalLinksEnabled: true,
	jumpOptions: { behavior: "smooth", align: "start" },
} satisfies Required<AnnotationLayerParams>;

export const useAnnotationLayer = (params: AnnotationLayerParams) => {
	// `params` is a fresh object on every render (the AnnotationLayer component
	// passes an object literal, and `jumpOptions` defaults to a literal too), so
	// depending on `params` made this memo — and the render effect below that
	// rebuilds the annotation DOM + re-parses annotations — re-run on EVERY
	// re-render. Depend on the primitive leaves so it only changes on real input
	// changes (and so real option changes still re-render, unlike a ref), while
	// keeping the original `{ ...defaults, ...params }` merge semantics.
	const mergedParams = useMemo(() => {
		return { ...defaultAnnotationLayerParams, ...params };
	}, [
		params.renderForms,
		params.externalLinksEnabled,
		params.jumpOptions?.behavior,
		params.jumpOptions?.align,
	]);
	const annotationLayerRef = useRef<HTMLDivElement>(null);
	const annotationLayerObjectRef = useRef<unknown>(null);
	const linkService = usePDFLinkService();
	const { visible } = useVisibility({
		elementRef: annotationLayerRef,
	});

	const pageNumber = usePDFPageNumber();
	const pdfPageProxy = usePdf((state) => state.getPdfPageProxy(pageNumber));
	const pdfDocumentProxy = usePdf((state) => state.pdfDocumentProxy);

	// Apply external links setting to link service
	useEffect(() => {
		linkService.externalLinkEnabled = mergedParams.externalLinksEnabled;
	}, [linkService, mergedParams.externalLinksEnabled]);

	const { jumpToPage, scrollToHighlightRects } = usePdfJump();
	const viewports = usePdf((state) => state.viewports);

	// Connect the LinkService to the viewer's scrolling so link annotations
	// navigate. When the destination carries a position, scroll to it within
	// the target page; otherwise fall back to a whole-page jump.
	useEffect(() => {
		if (!jumpToPage) return;

		const handlePageNavigation = (
			targetPageNumber: number,
			explicitDest?: unknown[],
		) => {
			const top = getDestinationScrollTop(
				viewports?.[targetPageNumber - 1],
				explicitDest,
			);
			const scrolled =
				top !== null &&
				scrollToHighlightRects(
					[{ pageNumber: targetPageNumber, top, left: 0, width: 0, height: 0 }],
					"pixels",
					mergedParams.jumpOptions?.align === "center" ? "center" : "start",
					0,
					mergedParams.jumpOptions?.behavior ?? "smooth",
				);
			if (!scrolled) {
				jumpToPage(targetPageNumber, mergedParams.jumpOptions);
			}
		};

		linkService.registerPageNavigationCallback(handlePageNavigation);

		// Unregister only this layer's callback: pages mount/unmount constantly
		// under virtualization and must not clobber each other's registration.
		return () => {
			linkService.unregisterPageNavigationCallback(handlePageNavigation);
		};
	}, [
		jumpToPage,
		scrollToHighlightRects,
		viewports,
		linkService,
		mergedParams.jumpOptions,
	]);

	useEffect(() => {
		ensureAnnotationLayerStyles();
	}, []);

	// Add event handler for link clicks
	useEffect(() => {
		if (!annotationLayerRef.current) return;

		const element = annotationLayerRef.current;

		// Handler for link clicks in the annotation layer
		const handleLinkClick = (e: MouseEvent) => {
			// Only handle links in annotation layer
			if (!e.target || !(e.target instanceof HTMLAnchorElement)) return;

			const target = e.target as HTMLAnchorElement;
			const href = target.getAttribute("href") || "";

			if (href.startsWith("#page=")) {
				e.preventDefault();
				// pdf.js destination links (marked data-internal-link) navigate via
				// their own click handler calling goToDestination — dispatching here
				// too would double-navigate, and their href's page number comes from
				// the PDF object number, not a page index. Only URI annotations with
				// a literal #page=N hash need the goToPage fallback.
				if (!target.closest("[data-internal-link]")) {
					const pageNumber = parseInt(href.substring(6), 10);
					if (!Number.isNaN(pageNumber)) {
						linkService.goToPage(pageNumber);
					}
				}
			}
			// External links will be handled by browser
		};

		element.addEventListener("click", handleLinkClick as EventListener);

		return () => {
			element.removeEventListener("click", handleLinkClick as EventListener);
		};
	}, [linkService]);

	useEffect(() => {
		if (!annotationLayerRef.current) {
			return;
		}

		if (visible) {
			annotationLayerRef.current.style.contentVisibility = "visible";
		} else {
			annotationLayerRef.current.style.contentVisibility = "hidden";
		}
	}, [visible]);

	useEffect(() => {
		if (!annotationLayerRef.current || !pdfPageProxy || !pdfDocumentProxy) {
			return;
		}

		// Update the pdfDocumentProxy in the linkService
		if (linkService._pdfDocumentProxy !== pdfDocumentProxy) {
			linkService.setDocument(pdfDocumentProxy);
		}

		const container = annotationLayerRef.current;
		let cancelled = false;

		container.replaceChildren();
		container.className = "annotationLayer";

		const viewport = pdfPageProxy.getViewport({ scale: 1 }).clone({
			dontFlip: true,
		});

		const annotationLayerConfig = {
			div: container,
			viewport: viewport,
			page: pdfPageProxy,
			linkService: linkService as never,
			annotationStorage: undefined,
			accessibilityManager: undefined,
			annotationCanvasMap: undefined,
			annotationEditorUIManager: undefined,
			structTreeLayer: undefined,
			commentManager: undefined,
		};

		(async () => {
			try {
				if (cancelled) return;
				const { AnnotationLayer } = await import(
					"pdfjs-dist/legacy/build/pdf.mjs"
				);
				if (cancelled) return;
				const annotationLayer = new AnnotationLayer(annotationLayerConfig);
				annotationLayerObjectRef.current = annotationLayer;
				const annotations = await pdfPageProxy.getAnnotations();
				if (cancelled) return;

				await annotationLayer.render({
					...annotationLayerConfig,
					...mergedParams,
					annotations,
					linkService: linkService as never,
				});
			} catch (_error) {
				// Silently handle rendering errors
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [pdfPageProxy, pdfDocumentProxy, mergedParams, linkService]);

	return {
		annotationLayerRef,
	};
};
