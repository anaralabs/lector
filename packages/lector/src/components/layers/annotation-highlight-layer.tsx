import type React from "react";

import type { Annotation } from "../../hooks/useAnnotations";
import { useAnnotations } from "../../hooks/useAnnotations";
import { usePDFPageNumber } from "../../hooks/usePdfPageNumber";
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

	const pageAnnotations = annotations.filter(
		(annotation) => annotation.pageNumber === pageNumber,
	);

	const getCommentIconPosition = (highlights: Annotation["highlights"]) => {
		if (!highlights.length) return { top: 0, right: 10 };

		// Sort highlights by vertical position to group them into lines
		const sortedHighlights = [...highlights].sort((a, b) => {
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
						<div
							style={{ cursor: "pointer" }}
							onClick={() => onAnnotationClick?.(annotation)}
						>
							{annotation.highlights.map((highlight, index) => (
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
								annotation.underlines?.map((rect, index) => (
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

							{annotation.comment && commmentIcon && (
								<div
									className={commentIconClassName}
									style={{
										position: "absolute",
										...getCommentIconPosition(annotation.highlights),
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
					</AnnotationTooltip>
				);
			})}
		</div>
	);
};
