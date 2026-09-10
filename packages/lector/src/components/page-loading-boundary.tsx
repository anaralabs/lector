import { type ReactNode, useEffect, useState } from "react";
import { usePdf } from "../internal";

/** Keep synchronous page layers behind actual PDF.js page availability. */
export function PageLoadingBoundary({
	pageNumber,
	children,
	fallback = null,
}: {
	pageNumber: number;
	children: ReactNode;
	fallback?: ReactNode;
}) {
	const loaded = usePdf((state) => state.isPageLoaded(pageNumber));
	const loadPage = usePdf((state) => state.loadPdfPageProxy);
	const [failure, setFailure] = useState<{
		pageNumber: number;
		error: unknown;
	} | null>(null);
	const [attempt, setAttempt] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: explicit retries restart failed page acquisition
	useEffect(() => {
		if (loaded) return;
		let disposed = false;
		setFailure(null);
		void loadPage(pageNumber).catch((error) => {
			if (!disposed) setFailure({ pageNumber, error });
		});
		return () => {
			disposed = true;
		};
	}, [pageNumber, loaded, loadPage, attempt]);
	if (loaded) return children;
	if (failure?.pageNumber === pageNumber)
		return (
			<div role="alert">
				Unable to load page {pageNumber}.{" "}
				<button type="button" onClick={() => setAttempt((value) => value + 1)}>
					Retry
				</button>
			</div>
		);
	return fallback;
}
