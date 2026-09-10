import { FileText } from "lucide-react";

export function ReaderLoading({ onRetry }: { onRetry?: () => void }) {
	return (
		<div className="reader-loading">
			<div className="reader-shell">
				<div className="reader-toolbar">
					<div className="document-title">
						<FileText size={15} aria-hidden="true" />
						<span>Attention Is All You Need</span>
					</div>
					{!onRetry && (
						<div className="reader-loading-controls" aria-hidden="true">
							<span />
							<span />
						</div>
					)}
				</div>
				{onRetry ? (
					<div className="document-stage reader-error">
						<p role="alert">The document couldn’t be opened.</p>
						<button type="button" className="secondary-link" onClick={onRetry}>
							Try again
						</button>
					</div>
				) : (
					<div className="document-stage reader-loading-stage" role="status">
						<span className="sr-only">Loading PDF</span>
						<div className="reader-skeleton-paper" aria-hidden="true">
							<div className="reader-skeleton-content">
								<div className="reader-skeleton-title" />
								<div className="reader-skeleton-authors" />
								<div className="reader-skeleton-abstract" />
								<div className="reader-skeleton-lines" />
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
