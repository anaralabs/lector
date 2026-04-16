type PdfJsModule = typeof import("pdfjs-dist");

let pdfJsPromise: Promise<PdfJsModule> | null = null;

export const loadPdfJs = () => {
	if (!pdfJsPromise) {
		pdfJsPromise = import("pdfjs-dist");
	}

	return pdfJsPromise;
};
