import type {
	OnProgressParameters,
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
import { getDefaultPdfJsAssetUrls, loadPdfJs } from "../../lib/pdfjs";

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
	/**
	 * Called when the document fails to load. Three failure modes:
	 *  - `phase: "pdfjs-load"` — the PDF.js worker / runtime itself failed to load.
	 *  - `phase: "document-load"` — `getDocument()` rejected (network error,
	 *    parse error, password required, etc). `onDocumentLoad` has NOT fired.
	 *  - `phase: "viewport-generation"` — the document loaded successfully and
	 *    `onDocumentLoad` already fired, but resolving page proxies / viewports
	 *    afterwards failed (e.g. corrupted page, transient pdf.js error).
	 * The callback fires in addition to the existing console.error, so existing
	 * consumers see no behavior change.
	 */
	onError?: ({
		error,
		phase,
		source,
	}: {
		error: unknown;
		phase: "pdfjs-load" | "document-load" | "viewport-generation";
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
	pdfJsVersion: string,
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

	const assetUrls = getDefaultPdfJsAssetUrls(pdfJsVersion);

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
		// PDF.js 5.x split out auxiliary resources that are loaded on demand.
		// Without these URLs, several content types render as blank pages
		// because pdf.js silently fails to load decoders / fonts / colour
		// profiles. The most visible symptom: scanned PDFs with JPEG2000 or
		// JBIG2 images (Internet Archive, government archives) render as
		// completely blank pages — every image fails with
		// "OpenJPEG failed to initialize". Defaulting these to a versioned
		// jsDelivr URL gets the viewer working out of the box; production
		// deployments should self-host and pass overrides via
		// `documentOptions`.
		wasmUrl: assetUrls.wasmUrl,
		cMapUrl: assetUrls.cMapUrl,
		cMapPacked: true,
		standardFontDataUrl: assetUrls.standardFontDataUrl,
		iccUrl: assetUrls.iccUrl,
	};

	return { ...defaults, ...params, ...overrides };
}

export const usePDFDocumentContext = ({
	onDocumentLoad,
	onError,
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

	// Same reasoning as documentOptionsRef: keep the effect stable while
	// always invoking the latest callback.
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;

	// biome-ignore lint/correctness/useExhaustiveDependencies: <onDocumnetLoad,zoomOptions>
	useEffect(() => {
		const generateViewports = async (pdf: PDFDocumentProxy) => {
			const pageProxies: Array<PDFPageProxy> = [];
			const rotations: number[] = [];
			const viewports = await Promise.all(
				Array.from({ length: pdf.numPages }, async (_, index) => {
					const page = await pdf.getPage(index + 1);
					// sometimes there is information about the default rotation of the document
					// stored in page.rotate. we need to always add that additional rotaton offset
					const deltaRotate = page.rotate || 0;
					const viewport = page.getViewport({
						scale: 1,
						rotation: rotation + deltaRotate,
					});
					pageProxies.push(page);
					rotations.push(page.rotate);
					return viewport;
				}),
			);

			const sortedPageProxies = pageProxies.toSorted(
				(a, b) => a.pageNumber - b.pageNumber,
			);
			setInitialState((prev) => ({
				...prev,
				isZoomFitWidth,
				viewports,
				pageProxies: sortedPageProxies,
				pdfDocumentProxy: pdf,
				zoom,
				zoomOptions,
			}));
		};

		const loadDocument = () => {
			setInitialState(null);
			setProgress(0);
			let loadingTask: PDFDocumentLoadingTask | null = null;
			let isDisposed = false;

			void loadPdfJs()
				.then(({ getDocument, version }) => {
					if (isDisposed) {
						return;
					}

					loadingTask = getDocument(
						buildDocumentInitParams(
							source,
							version,
							documentOptionsRef.current,
						),
					);
					loadingTask.onProgress = (progressEvent: OnProgressParameters) => {
						if (progressEvent.loaded === progressEvent.total) {
							return;
						}

						setProgress(progressEvent.loaded / progressEvent.total);
					};

					return loadingTask.promise
						.then(async (proxy) => {
							if (isDisposed || loadingTask?.destroyed) {
								return;
							}

							onDocumentLoad?.({ proxy, source });
							setProgress(1);

							try {
								await generateViewports(proxy);
							} catch (error) {
								if (isDisposed || loadingTask?.destroyed) {
									return;
								}

								console.error("Error generating PDF viewports", error);
								onErrorRef.current?.({
									error,
									phase: "viewport-generation",
									source,
								});
							}
						})
						.catch((error) => {
							if (isDisposed || loadingTask?.destroyed) {
								return;
							}

							console.error("Error loading PDF document", error);
							onErrorRef.current?.({
								error,
								phase: "document-load",
								source,
							});
						});
				})
				.catch((error) => {
					if (isDisposed) {
						return;
					}

					console.error("Error loading PDF.js", error);
					onErrorRef.current?.({
						error,
						phase: "pdfjs-load",
						source,
					});
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
