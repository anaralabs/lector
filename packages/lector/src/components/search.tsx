import type { PDFPageProxy } from "pdfjs-dist";
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
	| { pages: PDFPageProxy[]; status: "ready" }
	| { pages: PDFPageProxy[]; status: "error"; error: unknown };

export const Search = ({
	children,
	loading = "Loading...",
	errorFallback,
}: SearchProps) => {
	const [result, setResult] = useState<IndexingResult | null>(null);
	const [attempt, setAttempt] = useState(0);
	const proxies = usePdf((state) => state.pageProxies);
	const setTextContent = usePdf((state) => state.setTextContent);
	const retry = useCallback(() => {
		setResult(null);
		setAttempt((value) => value + 1);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: explicit retries reacquire an evicted failed job
	useEffect(() => {
		let disposed = false;
		setResult(null);
		const task = acquireDocumentText(proxies);
		void task.promise
			.then((text) => {
				if (disposed) return;
				setTextContent(text);
				setResult({ pages: proxies, status: "ready" });
			})
			.catch((error) => {
				if (disposed) return;
				console.error("Error extracting PDF text", error);
				setResult({ pages: proxies, status: "error", error });
			});
		return () => {
			disposed = true;
			task.release();
		};
	}, [proxies, setTextContent, attempt]);

	if (!result || result.pages !== proxies) return loading;
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
