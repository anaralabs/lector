import { type Annotation, useAnnotations } from "@anaralabs/lector";
import type React from "react";
import { useCallback, useState } from "react";

export const SelectionTooltipContent = ({
	onHighlight,
	onComment,
}: {
	onHighlight: () => void;
	onComment: () => void;
}) => {
	return (
		<div className="flex gap-2 bg-background rounded-lg p-2 border-border border">
			<button
				onClick={onHighlight}
				className="text-yellow-600 hover:text-yellow-800 text-sm"
			>
				Highlight
			</button>
			<button
				onClick={onComment}
				className="text-blue-600 hover:text-blue-800 text-sm"
			>
				Comment
			</button>
		</div>
	);
};

export interface AnnotationListProps {
	annotations: Annotation[];
	focusedAnnotationId?: string;
	onAnnotationClick: (annotation: Annotation | null) => void;
}

export const AnnotationList = ({
	annotations,
	focusedAnnotationId,
	onAnnotationClick,
}: AnnotationListProps) => {
	return (
		<div className="h-32 border overflow-y-auto bg-white rounded-lg">
			<div className="p-2">
				<h3 className="font-semibold mb-2">Annotations</h3>
				<div className="space-y-2">
					{annotations.map((annotation) => (
						<div
							key={annotation.id}
							className={`p-2 rounded cursor-pointer transition-colors ${
								focusedAnnotationId === annotation.id
									? "bg-yellow-100"
									: "hover:bg-gray-100"
							}`}
							onClick={() => onAnnotationClick(annotation)}
						>
							<div className="flex items-center gap-2">
								<div
									className="w-4 h-4 rounded"
									style={{ backgroundColor: annotation.color }}
								/>
								<div className="flex-grow">
									<div className="text-sm">
										{annotation.comment ? "Highlight" : "No comment"}
									</div>
									<div className="text-xs text-gray-500 flex gap-2">
										<span>Page {annotation.pageNumber}</span>
									</div>
								</div>
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
};

export interface TooltipContentProps {
	annotation: Annotation;
	onClose: () => void;
	onAddComment?: (highlight: Annotation) => void;
}

export const TooltipContent = ({
	annotation,
	onClose,
}: TooltipContentProps) => {
	const { updateAnnotation, deleteAnnotation } = useAnnotations();
	const [comment, setComment] = useState(annotation.comment || "");
	const [isEditing, setIsEditing] = useState(false);

	const handleSaveComment = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			const updates: Partial<Annotation> = { comment };

			updateAnnotation(annotation.id, updates);
			setIsEditing(false);
			onClose?.();
		},
		[annotation.id, comment, updateAnnotation, onClose],
	);

	const handleColorChange = useCallback(
		(e: React.MouseEvent, color: string) => {
			e.stopPropagation();
			const updates: Partial<Annotation> = { color };

			updateAnnotation(annotation.id, updates);
			onClose?.();
		},
		[annotation.id, updateAnnotation, onClose],
	);

	const handleStartEditing = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		setIsEditing(true);
	}, []);

	const handleCancelEdit = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		setIsEditing(false);
	}, []);

	const handleDelete = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			deleteAnnotation(annotation.id);
			onClose?.();
		},
		[annotation.id, deleteAnnotation, onClose],
	);

	const colors = [
		"rgba(255, 255, 0, 0.3)", // Yellow
		"rgba(0, 255, 0, 0.3)", // Green
		"rgba(255, 182, 193, 0.3)", // Pink
		"rgba(135, 206, 235, 0.3)", // Sky Blue
	];

	const handleTooltipClick = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
	}, []);

	return (
		<div
			className="flex flex-col gap-2 bg-white rounded-lg p-2"
			onClick={handleTooltipClick}
		>
			{/* Color picker - only show for highlights */}
			<div className="flex items-center justify-center gap-2">
				{colors.map((color) => (
					<button
						key={color}
						className="w-6 h-6 rounded"
						style={{ backgroundColor: color }}
						onClick={(e) => handleColorChange(e, color)}
					/>
				))}
			</div>

			{/* Comment section */}
			{isEditing ? (
				<div className="flex flex-col gap-2">
					<textarea
						value={comment}
						onChange={(e) => setComment(e.target.value)}
						className="border rounded p-2 text-sm"
						placeholder="Add a comment..."
						rows={3}
						onClick={(e) => e.stopPropagation()}
					/>
					<div className="flex justify-end gap-2">
						<button
							onClick={handleCancelEdit}
							className="px-2 py-1 text-sm text-gray-600 hover:text-gray-800"
						>
							Cancel
						</button>
						<button
							onClick={handleSaveComment}
							className="px-2 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
						>
							Save
						</button>
					</div>
				</div>
			) : (
				<div className="flex flex-col gap-2 bg-white rounded-lg p-2">
					{/* Comment display/edit */}
					{annotation.comment ? (
						<div className="flex flex-col gap-2">
							<div className="text-sm text-gray-700">{annotation.comment}</div>
							<button
								onClick={handleStartEditing}
								className="text-xs text-blue-500 hover:text-blue-600 self-start"
							>
								Edit comment
							</button>
						</div>
					) : (
						<button
							onClick={handleStartEditing}
							className="text-sm text-blue-500 hover:text-blue-600 self-start"
						>
							Add comment
						</button>
					)}

					{/* Delete button */}
					<button
						onClick={handleDelete}
						className="text-sm text-red-500 hover:text-red-600 self-start"
					>
						Delete
					</button>
				</div>
			)}
		</div>
	);
};
