import type {
	OnProgressParameters,
	PageViewport,
	PDFDocumentLoadingTask,
	PDFDocumentProxy,
	PDFPageProxy,
} from "pdfjs-dist";
import type {
	DocumentInitParameters,
	TypedArray,
} from "pdfjs-dist/types/src/display/api";
import { useEffect, useRef, useState } from "react";

import type { InitialPDFState, ZoomOptions } from "../../internal";
import { loadPdfJs } from "../../lib/pdfjs";

export interface usePDFDocumentParams {
	/**
	 * The URL of the PDF file to load.
	 */
	source: Source;
	onDocumentLoad?: ({
		proxy,
		source,
	}: {
		proxy: PDFDocumentProxy;
		source: Source;
	}) => void;
	initialRotation?: number;
	isZoomFitWidth?: boolean;
	zoom?: number;
	zoomOptions?: ZoomOptions;
	/**
	 * Override or extend the PDF.js DocumentInitParameters passed to getDocument().
	 * These take highest precedence over both the source object and lector's defaults.
	 * Must be a stable reference (module-level constant or useMemo) to avoid reloading the document.
	 */
	documentOptions?: Partial<DocumentInitParameters>;
}

export type Source =
	| string
	| URL
	| TypedArray
	| ArrayBuffer
	| DocumentInitParameters;

function buildDocumentInitParams(
	source: Source,
	overrides?: Partial<DocumentInitParameters>,
): DocumentInitParameters {
	let params: DocumentInitParameters;

	if (typeof source === "string" || source instanceof URL) {
		params = { url: source };
	} else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
		params = { data: source };
	} else {
		params = { ...source };
	}

	const defaults: Partial<DocumentInitParameters> = {
		// Skip the slow _guessMax binary-search auto-detection of max canvas area.
		// 1 GiB = 256 megapixels at 4 bytes/pixel. If the device can't allocate
		// this, pdfjs falls back gracefully via try/catch.
		canvasMaxAreaInBytes: 1024 * 1024 * 1024,
		// Enable GPU-backed canvases (willReadFrequently: false). PDF viewers are
		// render-dominated — they don't call getImageData() — so GPU compositing
		// is the correct path. This is the browser's default when no hint is given.
		enableHWA: true,
		// Explicitly opt-in to OffscreenCanvas in the worker for image processing.
		// Already the browser default, but being explicit avoids edge cases.
		isOffscreenCanvasSupported: true,
	};

	return { ...defaults, ...params, ...overrides };
}

export const usePDFDocumentContext = ({
	onDocumentLoad,
	source,
	initialRotation = 0,
	isZoomFitWidth,
	zoom = 1,
	zoomOptions,
	documentOptions,
}: usePDFDocumentParams) => {
	const [_, setProgress] = useState(0);

	const [initialState, setInitialState] = useState<InitialPDFState | null>();
	const [rotation] = useState<number>(initialRotation);

	// Ref so the effect always reads the latest documentOptions without
	// needing it in the dependency array (avoids reload on every render
	// when consumers pass an inline object).
	const documentOptionsRef = useRef(documentOptions);
	documentOptionsRef.current = documentOptions;

	// biome-ignore lint/correctness/useExhaustiveDependencies: <onDocumnetLoad,zoomOptions>
	useEffect(() => {
		// Number of pages to load eagerly before showing UI.
		// Remaining pages are loaded in the background after first paint.
		const EAGER_PAGE_COUNT = 5;

		const generateViewports = async (pdf: PDFDocumentProxy) => {
			const totalPages = pdf.numPages;
			const eagerCount = Math.min(EAGER_PAGE_COUNT, totalPages);

			// Load initial batch of pages eagerly
			const eagerProxies: Array<PDFPageProxy> = [];
			const viewports: Array<PageViewport> = [];

			await Promise.all(
				Array.from({ length: eagerCount }, async (_, index) => {
					const page = await pdf.getPage(index + 1);
					const deltaRotate = page.rotate || 0;
					const viewport = page.getViewport({
						scale: 1,
						rotation: rotation + deltaRotate,
					});
					eagerProxies[index] = page;
					viewports[index] = viewport;
				}),
			);

			// Estimate remaining page viewports from the first page to unblock the virtualizer
			if (totalPages > eagerCount && viewports[0]) {
				const templateViewport = viewports[0];
				for (let i = eagerCount; i < totalPages; i++) {
					viewports[i] = templateViewport;
				}
			}

			// Build sparse array — eagerly loaded pages are present, rest are undefined
			const allProxies: Array<PDFPageProxy | undefined> = new Array(totalPages);
			for (let i = 0; i < eagerCount; i++) {
				allProxies[i] = eagerProxies[i];
			}

			setInitialState((prev) => ({
				...prev,
				isZoomFitWidth,
				viewports,
				pageProxies: allProxies as PDFPageProxy[],
				pdfDocumentProxy: pdf,
				zoom,
				zoomOptions,
			}));

			// Load remaining pages in small batches in the background
			const BATCH_SIZE = 10;
			for (let start = eagerCount; start < totalPages; start += BATCH_SIZE) {
				const end = Math.min(start + BATCH_SIZE, totalPages);
				const batchProxies = await Promise.all(
					Array.from({ length: end - start }, async (_, j) => {
						const idx = start + j;
						const page = await pdf.getPage(idx + 1);
						const deltaRotate = page.rotate || 0;
						const viewport = page.getViewport({
							scale: 1,
							rotation: rotation + deltaRotate,
						});
						return { page, viewport, idx };
					}),
				);

				setInitialState((prev) => {
					if (!prev) return prev;
					const updatedViewports = [...prev.viewports];
					const updatedProxies = [...prev.pageProxies];
					for (const { page, viewport, idx } of batchProxies) {
						updatedViewports[idx] = viewport;
						updatedProxies[idx] = page;
					}
					return {
						...prev,
						viewports: updatedViewports,
						pageProxies: updatedProxies,
					};
				});
			}
		};

		const loadDocument = () => {
			setInitialState(null);
			setProgress(0);
			let loadingTask: PDFDocumentLoadingTask | null = null;
			let isDisposed = false;

			void loadPdfJs()
				.then(({ getDocument }) => {
					if (isDisposed) {
						return;
					}

					loadingTask = getDocument(
						buildDocumentInitParams(source, documentOptionsRef.current),
					);
					loadingTask.onProgress = (progressEvent: OnProgressParameters) => {
						if (progressEvent.loaded === progressEvent.total) {
							return;
						}

						setProgress(progressEvent.loaded / progressEvent.total);
					};

					return loadingTask.promise
						.then((proxy) => {
							if (isDisposed || loadingTask?.destroyed) {
								return;
							}

							onDocumentLoad?.({ proxy, source });
							setProgress(1);

							return generateViewports(proxy);
						})
						.catch((error) => {
							if (isDisposed || loadingTask?.destroyed) {
								return;
							}

							console.error("Error loading PDF document", error);
						});
				})
				.catch((error) => {
					if (isDisposed) {
						return;
					}

					console.error("Error loading PDF.js", error);
				});

			return () => {
				isDisposed = true;
				void loadingTask?.destroy();
			};
		};
		return loadDocument();
	}, [source]);

	return {
		initialState,
	};
};
