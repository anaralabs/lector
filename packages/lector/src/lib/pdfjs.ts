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
