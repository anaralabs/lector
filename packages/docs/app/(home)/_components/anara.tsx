"use client";

import {
	type Annotation,
	AnnotationHighlightLayer,
	CanvasLayer,
	type HighlightRect,
	Page,
	Pages,
	Root,
	SelectionTooltip,
	TextLayer,
	useAnnotations,
	usePdfJump,
	useSelectionDimensions,
} from "@anaralabs/lector";
import React, { useCallback, useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import "pdfjs-dist/web/pdf_viewer.css";

import { GlobalWorkerOptions } from "pdfjs-dist";
import { cn } from "@/lib/utils";
import {
	SelectionTooltipContent,
	TooltipContent,
	type TooltipContentProps,
} from "./annotations";
import { CommentInput } from "./comment-input";
import DocumentMenu from "./document-menu";
import { PageNavigation } from "./page-navigation";
import ZoomMenu from "./zoom-menu";

const fileUrl = "/pdf/pathways.pdf";
const STORAGE_KEY = "pdf-annotations";

GlobalWorkerOptions.workerSrc = new URL(
	"pdfjs-dist/build/pdf.worker.mjs",
	import.meta.url,
).toString();

interface PDFContentProps {
	onAnnotationsChange: (annotations: Annotation[]) => void;
	initialAnnotations?: Annotation[];
	focusedAnnotationId?: string;
	onAnnotationClick: (annotation: Annotation | null) => void;
}

const CommentIcon = ({ className }: { className?: string }) => (
	<svg
		className={className}
		width="12"
		height="12"
		viewBox="0 0 24 24"
		fill="currentColor"
		aria-hidden="true"
	>
		<path d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4v6l4-4h8c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z" />
	</svg>
);

const PDFContent = ({
	onAnnotationsChange,
	focusedAnnotationId,
	onAnnotationClick,
}: PDFContentProps) => {
	const { addAnnotation, annotations, updateAnnotation, deleteAnnotation } =
		useAnnotations();
	const { getAnnotationDimension } = useSelectionDimensions();
	const { jumpToHighlightRects } = usePdfJump();
	const [pendingSelection, setPendingSelection] = useState<{
		highlights: HighlightRect[];
		underlines: HighlightRect[];
		text: string;
		pageNumber: number;
	} | null>(null);
	const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(
		null,
	);

	useEffect(() => {
		onAnnotationsChange(annotations);
	}, [annotations, onAnnotationsChange]);

	const handleCreateAnnotation = useCallback(() => {
		const selection = getAnnotationDimension();
		if (!selection || !selection.highlights.length) return;

		const newAnnotation = {
			pageNumber: selection.highlights[0].pageNumber,
			highlights: selection.highlights,
			underlines: selection.underlines,
			color: "rgba(255, 213, 0, 0.3)", // Yellow color for highlights
			borderColor: "rgba(255, 213, 0, 0.8)",
			text: selection.text,
			id: uuidv4(),
			createdAt: new Date(),
			updatedAt: new Date(),
		} as Annotation;

		addAnnotation(newAnnotation);
		window.getSelection()?.removeAllRanges();
	}, [addAnnotation, getAnnotationDimension]);

	const handleCreateComment = useCallback(() => {
		const selection = getAnnotationDimension();
		if (!selection || !selection.highlights.length) return;

		// First create a temporary highlight
		const newAnnotationId = uuidv4();
		const newAnnotation = {
			pageNumber: selection.highlights[0].pageNumber,
			highlights: selection.highlights,
			underlines: selection.underlines,
			color: "rgba(59, 130, 246, 0.3)", // Blue color for comments
			borderColor: "rgba(59, 130, 246, 0.8)",
			text: selection.text,
			id: newAnnotationId,
			createdAt: new Date(),
			updatedAt: new Date(),
			isCommentPending: true, // Add this flag to identify highlights created for commenting
		} as Annotation;

		addAnnotation(newAnnotation);
		window.getSelection()?.removeAllRanges();

		// Immediately show comment input for this annotation
		setEditingAnnotationId(newAnnotationId);
		setPendingSelection({
			highlights: selection.highlights,
			underlines: selection.underlines,
			text: selection.text,
			pageNumber: selection.highlights[0].pageNumber,
		});

		// Show the tooltip for this annotation
		onAnnotationClick(newAnnotation);
	}, [addAnnotation, getAnnotationDimension, onAnnotationClick]);

	const handleAddCommentToHighlight = useCallback((highlight: Annotation) => {
		if (!highlight.highlights.length) return;

		// For existing highlights, we need to generate underlines from highlights
		// Use the same logic as in useSelectionDimensions for consistency
		const underlines = highlight.highlights.map((h) => ({
			...h,
			height: Math.max(1, h.height * 0.05), // Thin underline, same as selection logic
			top: h.top + h.height * 0.85, // Position at baseline, same as selection logic
		}));

		setEditingAnnotationId(highlight.id);
		setPendingSelection({
			highlights: highlight.highlights,
			underlines: underlines,
			text: highlight.metadata?.text as string,
			pageNumber: highlight.pageNumber,
		});
	}, []);

	const handleSaveComment = useCallback(
		(comment: string) => {
			if (!pendingSelection || !editingAnnotationId) return;

			const updates = {
				comment,
				updatedAt: new Date(),
			} as Partial<Annotation>;

			updateAnnotation(editingAnnotationId, updates);
			setEditingAnnotationId(null);
			setPendingSelection(null);
		},
		[updateAnnotation, pendingSelection, editingAnnotationId],
	);

	const handleCancelComment = useCallback(() => {
		// If this was a new comment (not editing an existing one), delete the temporary highlight
		if (editingAnnotationId) {
			const annotation = annotations.find((a) => a.id === editingAnnotationId);
			if (annotation && !annotation.comment) {
				// Only delete if it doesn't already have a comment
				deleteAnnotation(editingAnnotationId);
			}
		}

		setEditingAnnotationId(null);
		setPendingSelection(null);
	}, [editingAnnotationId, annotations, deleteAnnotation]);

	useEffect(() => {
		if (!focusedAnnotationId) return;

		const annotation = annotations.find((a) => a.id === focusedAnnotationId);
		if (!annotation || !annotation.highlights.length) return;

		jumpToHighlightRects(annotation.highlights, "pixels", "center", -50);
	}, [focusedAnnotationId, annotations, jumpToHighlightRects]);

	const handlePagesClick = useCallback(
		(e: React.MouseEvent) => {
			const target = e.target as HTMLElement;

			if (target.closest('[role="tooltip"]')) {
				return;
			}

			const clickedHighlight = target.closest("[data-highlight-id]");

			// If we clicked on a highlight, let the AnnotationHighlightLayer handle it
			if (clickedHighlight) {
				return;
			}

			if (focusedAnnotationId) {
				onAnnotationClick(null);
			}
		},
		[focusedAnnotationId, onAnnotationClick],
	);

	const renderTooltipContent = useCallback(
		({ annotation, onClose }: TooltipContentProps) => {
			// If this annotation is being edited, show the comment input
			if (editingAnnotationId === annotation.id) {
				return (
					<CommentInput
						onSave={(comment) => {
							handleSaveComment(comment);
							onClose();
						}}
						onCancel={() => {
							handleCancelComment();
							onClose();
						}}
					/>
				);
			}

			return (
				<TooltipContent
					annotation={annotation}
					onClose={onClose}
					onAddComment={handleAddCommentToHighlight}
				/>
			);
		},
		[
			editingAnnotationId,
			handleSaveComment,
			handleCancelComment,
			handleAddCommentToHighlight,
		],
	);

	const handleAnnotationTooltipClose = useCallback(
		(annotation: Annotation) => {
			// Only delete the highlight if it was created for commenting and still has no comment
			if (annotation.isCommentPending && !annotation.comment) {
				deleteAnnotation(annotation.id);
			}
			setEditingAnnotationId(null);
			setPendingSelection(null);
		},
		[deleteAnnotation],
	);

	return (
		<Pages
			className="dark:invert-[94%] dark:hue-rotate-180 dark:brightness-[80%] dark:contrast-[228%] dark:bg-gray-100"
			onClick={handlePagesClick}
		>
			<Page>
				<CanvasLayer />
				<TextLayer />
				<AnnotationHighlightLayer
					highlightClassName="dark:opacity-40 mix-blend-multiply transition-all duration-200 cursor-pointer"
					underlineClassName="transition-all duration-200 cursor-pointer"
					commentIconClassName="text-blue-600 hover:text-blue-800"
					focusedAnnotationId={focusedAnnotationId}
					commentIconPosition="page"
					commmentIcon={<CommentIcon />}
					tooltipClassName="bg-white shadow-lg rounded-lg p-3 min-w-[200px]"
					onAnnotationClick={onAnnotationClick}
					onAnnotationTooltipClose={handleAnnotationTooltipClose}
					renderTooltipContent={renderTooltipContent}
					renderHoverTooltipContent={renderTooltipContent}
				/>
				<SelectionTooltip>
					<SelectionTooltipContent
						onHighlight={handleCreateAnnotation}
						onComment={handleCreateComment}
					/>
				</SelectionTooltip>
			</Page>
		</Pages>
	);
};
type AnaraViewerProps = {
	fullHeight?: boolean;
};

export const AnaraViewer = ({ fullHeight }: AnaraViewerProps) => {
	const [savedAnnotations, setSavedAnnotations] = React.useState<Annotation[]>(
		[],
	);
	const [focusedAnnotationId, setFocusedAnnotationId] = useState<string>();
	const { setAnnotations } = useAnnotations();

	// Load saved annotations and ensure backward compatibility
	React.useEffect(() => {
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			if (saved) {
				const annotations = JSON.parse(saved) as Annotation[];
				setSavedAnnotations(annotations);
				setAnnotations(annotations);
			}
		} catch (error) {
			console.error("Error loading annotations:", error);
		}
	}, [setAnnotations]);

	const handleAnnotationsChange = useCallback((annotations: Annotation[]) => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(annotations));
			setSavedAnnotations(annotations);
		} catch (error) {
			console.error("Error saving annotations:", error);
		}
	}, []);

	const handleAnnotationClick = useCallback((annotation: Annotation | null) => {
		setFocusedAnnotationId(annotation?.id);
	}, []);

	return (
		<div className="flex flex-col gap-4">
			<Root
				source={fileUrl}
				className={cn(
					"border overflow-hidden flex flex-col w-full h-[600px] rounded-lg",
					fullHeight && "h-screen",
				)}
				isZoomFitWidth={true}
				loader={<div className="w-full"></div>}
			>
				<div className="p-1 relative flex justify-between border-b">
					<ZoomMenu />
					<PageNavigation />
					<DocumentMenu documentUrl={fileUrl} />
				</div>
				{/* <div className="flex-1 relative"> */}
				<PDFContent
					initialAnnotations={savedAnnotations}
					onAnnotationsChange={handleAnnotationsChange}
					focusedAnnotationId={focusedAnnotationId}
					onAnnotationClick={handleAnnotationClick}
				/>
				{/* </div> */}
			</Root>
		</div>
	);
};
