import "pdfjs-dist/web/pdf_viewer.css";

if (typeof window !== "undefined") {
	import("pdfjs-dist/legacy/build/pdf.mjs").then(({ GlobalWorkerOptions }) => {
		GlobalWorkerOptions.workerSrc = new URL(
			"pdfjs-dist/legacy/build/pdf.worker.mjs",
			import.meta.url,
		).toString();
	});
}
