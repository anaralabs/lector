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

const defaultAnnotationLayerParams = {
	renderForms: true,
	externalLinksEnabled: true,
	jumpOptions: { behavior: "smooth", align: "start" },
} satisfies Required<AnnotationLayerParams>;

export const useAnnotationLayer = (params: AnnotationLayerParams) => {
	const mergedParams = useMemo(() => {
		return { ...defaultAnnotationLayerParams, ...params };
	}, [params]);
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

	const { jumpToPage } = usePdfJump();

	// Connect the LinkService to the jumpToPage function to enable PDF navigation through links
	useEffect(() => {
		if (!jumpToPage) return;

		// Define a callback function to handle page navigation
		const handlePageNavigation = (pageNumber: number) => {
			jumpToPage(pageNumber, mergedParams.jumpOptions);
		};

		// Register our callback with the LinkService
		linkService.registerPageNavigationCallback(handlePageNavigation);

		// Clean up the callback when the component unmounts
		return () => {
			linkService.unregisterPageNavigationCallback();
		};
	}, [jumpToPage, linkService, mergedParams.jumpOptions]);

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

			// Handle internal page links
			if (href.startsWith("#page=")) {
				e.preventDefault();
				const pageNumber = parseInt(href.substring(6), 10);
				if (!Number.isNaN(pageNumber)) {
					linkService.goToPage(pageNumber);
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
