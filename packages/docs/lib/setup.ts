import "pdfjs-dist/web/pdf_viewer.css";

let pdfJsWorkerPromise: Promise<void> | null = null;

export const ensurePdfJsWorker = () => {
	if (pdfJsWorkerPromise) {
		return pdfJsWorkerPromise;
	}

	pdfJsWorkerPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then(
		({ GlobalWorkerOptions }) => {
			GlobalWorkerOptions.workerSrc = new URL(
				"pdfjs-dist/legacy/build/pdf.worker.mjs",
				import.meta.url,
			).toString();
		},
	);

	return pdfJsWorkerPromise;
};

void ensurePdfJsWorker();
