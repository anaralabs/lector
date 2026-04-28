type PdfJsModule = typeof import("pdfjs-dist");

let pdfJsPromise: Promise<PdfJsModule> | null = null;

export const loadPdfJs = () => {
	if (!pdfJsPromise) {
		// Use the legacy build for broader browser compatibility.
		// The modern build uses bleeding-edge APIs (e.g. Map.getOrInsertComputed)
		// that aren't available in all browsers. The legacy build is functionally
		// identical with polyfills included.
		pdfJsPromise = import(
			"pdfjs-dist/legacy/build/pdf.mjs"
		) as Promise<PdfJsModule>;
	}

	return pdfJsPromise;
};

/**
 * Default asset URLs for PDF.js auxiliary resources.
 *
 * PDF.js 5.x ships these resources separately and requires URLs to fetch them
 * at runtime. Without them, certain content types fail to render entirely:
 *
 * - `wasmUrl`: WASM decoders for JPEG2000 (`openjpeg.wasm`) and JBIG2
 *   (`jbig2.wasm`), plus the JS fallback. Required for scanned PDFs from
 *   the Internet Archive, government archives, and any PDF using JPX or
 *   JBIG2 image streams. Without `wasmUrl`, JPEG2000 images fail with
 *   "OpenJPEG failed to initialize" and the page renders as a blank canvas.
 * - `cMapUrl`: Character maps for CJK / non-Latin fonts.
 * - `standardFontDataUrl`: Substitutions for the 14 PDF base fonts when
 *   not embedded.
 * - `iccUrl`: ICC color profiles for accurate color rendering.
 *
 * We default to a versioned jsDelivr URL so consumers get a working viewer
 * out of the box. Production deployments should self-host these assets and
 * pass them via `documentOptions` for offline support, CSP compliance, and
 * to avoid third-party CDN latency.
 *
 * jsDelivr is preferred over unpkg because it serves with permissive CORS
 * headers, has higher uptime, and supports range requests.
 */
const ASSET_CDN_BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist";

export interface PdfJsAssetUrls {
	wasmUrl: string;
	cMapUrl: string;
	standardFontDataUrl: string;
	iccUrl: string;
}

export const getDefaultPdfJsAssetUrls = (version: string): PdfJsAssetUrls => {
	const base = `${ASSET_CDN_BASE}@${version}`;
	return {
		wasmUrl: `${base}/wasm/`,
		cMapUrl: `${base}/cmaps/`,
		standardFontDataUrl: `${base}/standard_fonts/`,
		iccUrl: `${base}/iccs/`,
	};
};
