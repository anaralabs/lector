"use client";

import {
	CanvasLayer,
	HighlightLayer,
	Page,
	Pages,
	Root,
	SelectionTooltip,
	TextLayer,
	usePdf,
	usePdfJump,
	useSelectionDimensions,
} from "@anaralabs/lector";
import {
	ArrowDownToLine,
	ChevronLeft,
	ChevronRight,
	Eraser,
	FileText,
	Highlighter,
	Minus,
	Plus,
} from "lucide-react";
import { useState } from "react";
import "@/lib/setup";
import { ReaderLoading } from "./reader-loading";

const source = "/lector/pdf/attention-is-all-you-need.pdf";

function HighlightSelection() {
	const { getDimension } = useSelectionDimensions();
	const highlights = usePdf((state) => state.highlights);
	const setHighlight = usePdf((state) => state.setHighlight);
	return (
		<button
			className="selection-action"
			type="button"
			onMouseDown={(event) => event.preventDefault()}
			onClick={() => {
				const selection = getDimension();
				if (selection) setHighlight([...highlights, ...selection.highlights]);
				window.getSelection()?.removeAllRanges();
			}}
		>
			<Highlighter size={14} aria-hidden="true" /> Highlight
		</button>
	);
}

function ReaderContent() {
	const currentPage = usePdf((state) => state.currentPage);
	const totalPages = usePdf((state) => state.pdfDocumentProxy.numPages);
	const zoom = usePdf((state) => state.zoom);
	const updateZoom = usePdf((state) => state.updateZoom);
	const viewportRef = usePdf((state) => state.viewportRef);
	const viewports = usePdf((state) => state.viewports);
	const highlights = usePdf((state) => state.highlights);
	const setHighlight = usePdf((state) => state.setHighlight);
	const { jumpToPage } = usePdfJump();
	const fitWidth = () => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const style = getComputedStyle(viewport);
		const width =
			viewport.clientWidth -
			Number.parseFloat(style.paddingLeft) -
			Number.parseFloat(style.paddingRight);
		const pageWidth = Math.max(...viewports.map((page) => page.width));
		updateZoom(width / pageWidth, true);
	};
	return (
		<div
			className="reader-shell"
			role="region"
			aria-label="Attention Is All You Need PDF viewer"
		>
			<div className="reader-toolbar">
				<div className="document-title">
					<FileText size={15} aria-hidden="true" />
					<span>Attention Is All You Need</span>
				</div>
				<div className="reader-controls">
					<div className="toolbar-group page-controls">
						<button
							type="button"
							className="icon-button"
							aria-label="Previous page"
							disabled={currentPage <= 1}
							onClick={() => jumpToPage(currentPage - 1, { behavior: "auto" })}
						>
							<ChevronLeft size={15} />
						</button>
						<span className="page-count" aria-live="polite">
							{currentPage}
							<span>/</span>
							{totalPages}
						</span>
						<button
							type="button"
							className="icon-button"
							aria-label="Next page"
							disabled={currentPage >= totalPages}
							onClick={() => jumpToPage(currentPage + 1, { behavior: "auto" })}
						>
							<ChevronRight size={15} />
						</button>
					</div>
					<span className="toolbar-divider" />
					<div className="toolbar-group zoom-controls">
						<button
							type="button"
							className="icon-button"
							aria-label="Zoom out"
							disabled={zoom <= 0.25}
							onClick={() => updateZoom(Math.max(0.25, zoom / 1.15))}
						>
							<Minus size={14} />
						</button>
						<button
							type="button"
							className="zoom-value"
							aria-label="Fit page to width"
							title="Fit page to width"
							onClick={() => fitWidth()}
						>
							{Math.round(zoom * 100)}%
						</button>
						<button
							type="button"
							className="icon-button"
							aria-label="Zoom in"
							disabled={zoom >= 3}
							onClick={() => updateZoom(Math.min(3, zoom * 1.15))}
						>
							<Plus size={14} />
						</button>
					</div>
					<span className="toolbar-divider" />
					{highlights.length > 0 ? (
						<button
							type="button"
							className="icon-button"
							aria-label="Clear highlights"
							onClick={() => setHighlight([])}
						>
							<Eraser size={15} />
						</button>
					) : null}
					<a
						className="icon-button"
						href={source}
						download="attention-is-all-you-need.pdf"
						aria-label="Download Attention Is All You Need"
					>
						<ArrowDownToLine size={15} />
					</a>
				</div>
			</div>
			<div className="document-stage">
				<Pages
					className="landing-pages"
					gap={24}
					aria-label="PDF pages"
					tabIndex={0}
				>
					<Page className="landing-pdf-page">
						<CanvasLayer />
						<TextLayer />
						<HighlightLayer className="reader-highlight" />
					</Page>
				</Pages>
			</div>
			<div className="reader-selection">
				<SelectionTooltip>
					<HighlightSelection />
				</SelectionTooltip>
			</div>
		</div>
	);
}

export default function LandingReader() {
	const [error, setError] = useState(false);
	const [attempt, setAttempt] = useState(0);
	return (
		<Root
			key={attempt}
			source={source}
			className="landing-reader"
			isZoomFitWidth
			zoomOptions={{ minZoom: 0.25, maxZoom: 3 }}
			onError={() => setError(true)}
			loader={
				<ReaderLoading
					onRetry={
						error
							? () => {
									setError(false);
									setAttempt(attempt + 1);
								}
							: undefined
					}
				/>
			}
		>
			<ReaderContent />
		</Root>
	);
}
