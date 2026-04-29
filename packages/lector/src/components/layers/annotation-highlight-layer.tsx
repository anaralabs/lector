import type React from "react";
import { useMemo } from "react";

import type { Annotation } from "../../hooks/useAnnotations";
import { useAnnotations } from "../../hooks/useAnnotations";
import { usePDFPageNumber } from "../../hooks/usePdfPageNumber";
import { usePdf } from "../../internal";
import {
	AnnotationTooltip,
	type AnnotationTooltipContentProps,
} from "../annotation-tooltip";

interface AnnotationHighlightLayerProps {
	className?: string;
	style?: React.CSSProperties;
	renderTooltipContent: (
		props: AnnotationTooltipContentProps,
	) => React.ReactNode;
	renderHoverTooltipContent: (props: {
		annotation: Annotation;
		onClose: () => void;
	}) => React.ReactNode;
	focusedAnnotationId?: string;
	commmentIcon?: React.ReactNode;
	focusedHoverAnnotationId?: string;
	onAnnotationClick?: (annotation: Annotation) => void;
	onAnnotationTooltipClose?: (annotation: Annotation) => void;
	tooltipClassName?: string;
	hoverTooltipClassName?: string;
	highlightClassName?: string;
	commentIconPosition?: "highlight" | "page";
	underlineClassName?: string;
	commentIconClassName?: string;
}

export const AnnotationHighlightLayer = ({
	className,
	style,
	renderTooltipContent,
	renderHoverTooltipContent,
	tooltipClassName,
	highlightClassName,
	underlineClassName,
	commentIconPosition,
	commmentIcon,
	commentIconClassName,
	focusedAnnotationId,
	focusedHoverAnnotationId,
	onAnnotationClick,
	onAnnotationTooltipClose,
	hoverTooltipClassName,
}: AnnotationHighlightLayerProps) => {
	const { annotations } = useAnnotations();
	const pageNumber = usePDFPageNumber();
	const isPageRendered = usePdf((state) => !!state.renderedPages[pageNumber]);

	// An annotation belongs to this page if either its top-level pageNumber
	// matches OR any of its highlight/underline rectangles are on this page.
	// This is what lets a single annotation span two pages and still render
	// the right rectangles on each page (without spilling page-2 rects onto
	// page-1's coordinate space and vice versa).
	const pageAnnotations = useMemo(
		() =>
			annotations.filter(
				(a) =>
					a.pageNumber === pageNumber ||
					a.highlights.some((h) => h.pageNumber === pageNumber) ||
					a.underlines?.some((u) => u.pageNumber === pageNumber),
			),
		[annotations, pageNumber],
	);

	if (!isPageRendered) return null;

	const getCommentIconPosition = (highlights: Annotation["highlights"]) => {
		if (!highlights.length) return { top: 0, right: 10 };

		// Sort highlights by vertical position to group them into lines
		const sortedHighlights = highlights.toSorted((a, b) => {
			const topDiff = a.top - b.top;
			return Math.abs(topDiff) < 3 ? a.left - b.left : topDiff;
		});

		// Group highlights into lines (highlights within 3px vertical distance)
		const lines: (typeof highlights)[] = [];
		let currentLine: typeof highlights = [];

		sortedHighlights.forEach((highlight) => {
			if (currentLine.length === 0) {
				currentLine.push(highlight);
			} else {
				const firstInLine = currentLine[0]!;
				if (Math.abs(highlight.top - firstInLine.top) <= 3) {
					currentLine.push(highlight);
				} else {
					lines.push([...currentLine]);
					currentLine = [highlight];
				}
			}
		});
		if (currentLine.length > 0) {
			lines.push(currentLine);
		}

		// Find if any line extends beyond 80% of the page width
		// Assuming page width is around 600-800px in most PDFs
		const PAGE_WIDTH = 600;
		const hasLongLine = lines.some((line) => {
			if (line.length === 0) return false;
			const rightmost = Math.max(...line.map((h) => h.left + h.width));
			return rightmost > PAGE_WIDTH * 0.8;
		});

		const firstHighlight = highlights[0]!;

		const firstLine = lines[0] || [];
		const leftmost = Math.min(...firstLine.map((h) => h.left));
		const rightmost = Math.max(...firstLine.map((h) => h.left + h.width));
		const lineCenter = leftmost + (rightmost - leftmost) / 2;

		const shouldPositionRight = hasLongLine || lineCenter > PAGE_WIDTH * 0.5;

		const rightPosition =
			commentIconPosition === "highlight"
				? { left: rightmost + 8 }
				: { right: 10 };
		const leftPosition =
			commentIconPosition === "highlight"
				? { left: leftmost - 18 }
				: { left: 20 };
		return {
			top: firstHighlight.top + firstHighlight.height / 2 - 6,
			...(shouldPositionRight ? rightPosition : leftPosition),
		};
	};
	return (
		<div className={className} style={style}>
			{pageAnnotations.map((annotation) => {
				// Only render the rectangles that belong to this page. For a
				// multi-page annotation each page renders its own slice while
				// still sharing the same id / color / comment.
				const pageHighlights = annotation.highlights.filter(
					(h) => h.pageNumber === pageNumber,
				);
				const pageUnderlines = annotation.underlines?.filter(
					(u) => u.pageNumber === pageNumber,
				);

				// Skip when neither highlights nor underlines have anything
				// for this page, otherwise an annotation matched on
				// underlines alone would silently drop those underlines.
				if (
					pageHighlights.length === 0 &&
					(!pageUnderlines || pageUnderlines.length === 0)
				) {
					return null;
				}

				// Compute the lowest page that contains any rectangle (highlights
				// or underlines). The annotation's "primary" rendering page is
				// the first page with any rect; that's where the comment icon
				// shows and where the AnnotationTooltip is mounted.
				const minPage = (rects: { pageNumber: number }[] | undefined) =>
					rects?.reduce<number | null>(
						(m, r) => (m === null || r.pageNumber < m ? r.pageNumber : m),
						null,
					) ?? null;
				const minHighlightPage = minPage(annotation.highlights);
				const minUnderlinePage = minPage(annotation.underlines);
				const firstPageWithRects =
					minHighlightPage === null
						? minUnderlinePage
						: minUnderlinePage === null
							? minHighlightPage
							: Math.min(minHighlightPage, minUnderlinePage);
				const isPrimaryPage = firstPageWithRects === pageNumber;
				const showCommentIcon = isPrimaryPage;

				const rectsContent = (
					<div
						style={{ cursor: "pointer" }}
						onClick={() => onAnnotationClick?.(annotation)}
					>
						{pageHighlights.map((highlight, index) => (
							<div
								key={`highlight-${
									// biome-ignore lint/suspicious/noArrayIndexKey: <index>
									index
								}`}
								className={highlightClassName}
								style={{
									position: "absolute",
									top: highlight.top,
									left: highlight.left,
									width: highlight.width,
									height: highlight.height,
									backgroundColor: annotation.color,
								}}
								data-highlight-id={annotation.id}
							/>
						))}
						{annotation.comment &&
							pageUnderlines?.map((rect, index) => (
								<div
									key={`underline-${
										// biome-ignore lint/suspicious/noArrayIndexKey: <index>
										index
									}`}
									className={underlineClassName}
									style={{
										position: "absolute",
										top: rect.top,
										left: rect.left,
										width: rect.width,
										height: 1.1,
										backgroundColor: annotation.borderColor,
									}}
									data-comment-id={annotation.id}
								/>
							))}

						{annotation.comment &&
							commmentIcon &&
							showCommentIcon &&
							pageHighlights.length > 0 && (
								<div
									className={commentIconClassName}
									style={{
										position: "absolute",
										...getCommentIconPosition(pageHighlights),
										color: "gray",
										cursor: "pointer",
										zIndex: 10,
									}}
									data-comment-icon-id={annotation.id}
								>
									{commmentIcon}
								</div>
							)}
					</div>
				);

				// Only the primary page mounts the AnnotationTooltip, otherwise
				// each page would create its own portal and we'd render the
				// tooltip twice when the user has both pages on screen.
				// Secondary pages still render their rect slice with the click
				// handler so focusing the annotation still works.
				if (!isPrimaryPage) {
					return <div key={annotation.id}>{rectsContent}</div>;
				}

				return (
					<AnnotationTooltip
						key={annotation.id}
						annotation={annotation}
						className={tooltipClassName}
						hoverClassName={hoverTooltipClassName}
						focusedOpenId={focusedAnnotationId}
						focusedHoverOpenId={focusedHoverAnnotationId}
						isOpen={focusedAnnotationId === annotation.id}
						hoverIsOpen={focusedHoverAnnotationId === annotation.id}
						onOpenChange={(open) => {
							if (open && onAnnotationClick) {
								onAnnotationClick(annotation);
							} else if (!open && onAnnotationTooltipClose) {
								onAnnotationTooltipClose(annotation);
							}
						}}
						renderTooltipContent={renderTooltipContent}
						hoverTooltipContent={renderHoverTooltipContent({
							annotation,
							onClose: () => {},
						})}
					>
						{rectsContent}
					</AnnotationTooltip>
				);
			})}
		</div>
	);
};
