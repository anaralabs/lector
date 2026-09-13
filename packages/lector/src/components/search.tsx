import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useCallback, useEffect, useState } from "react";
import { usePdf } from "../internal";
import { acquireDocumentText } from "../lib/document-text";

interface SearchProps {
	children: React.ReactNode;
	loading?: React.ReactNode;
	/** Replace the default indexing-error message and retry button. */
	errorFallback?: (state: {
		error: unknown;
		retry: () => void;
	}) => React.ReactNode;
}

type IndexingResult =
	| { document: PDFDocumentProxy; pages: PDFPageProxy[]; status: "ready" }
	| {
			document: PDFDocumentProxy;
			pages: PDFPageProxy[];
			status: "error";
			error: unknown;
	  };

export const Search = ({
	children,
	loading = "Loading...",
	errorFallback,
}: SearchProps) => {
	const [result, setResult] = useState<IndexingResult | null>(null);
	const [attempt, setAttempt] = useState(0);
	const document = usePdf((state) => state.pdfDocumentProxy);
	const proxies = usePdf((state) => state.pageProxies);
	const pagesLoaded = usePdf((state) => state.pagesLoaded);
	const loadPages = usePdf((state) => state.loadPdfPageProxies);
	const setTextContent = usePdf((state) => state.setTextContent);
	const retry = useCallback(() => {
		setResult(null);
		setAttempt((value) => value + 1);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: explicit retries reacquire an evicted failed job
	useEffect(() => {
		let disposed = false;
		setResult(null);
		let task: ReturnType<typeof acquireDocumentText> | undefined;
		void loadPages()
			.then((pages) => {
				// Wait for the complete proxy snapshot to reach the store before
				// indexing, avoiding an abort/restart when its empty array is replaced.
				if (disposed || !pagesLoaded) return;
				task = acquireDocumentText(pages);
				return task.promise;
			})
			.then((text) => {
				if (disposed || !text) return;
				setTextContent(text);
				setResult({ document, pages: proxies, status: "ready" });
			})
			.catch((error) => {
				if (disposed) return;
				console.error("Error extracting PDF text", error);
				setResult({ document, pages: proxies, status: "error", error });
			});
		return () => {
			disposed = true;
			task?.release();
		};
	}, [document, proxies, pagesLoaded, loadPages, setTextContent, attempt]);

	if (!result || result.document !== document || result.pages !== proxies)
		return loading;
	if (result.status === "error") {
		if (errorFallback) return errorFallback({ error: result.error, retry });
		return (
			<div role="alert">
				Unable to index this document for search.{" "}
				<button type="button" onClick={retry}>
					Retry
				</button>
			</div>
		);
	}
	return children;
};
