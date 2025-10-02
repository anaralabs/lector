import type { Annotation } from "@anaralabs/lector";
import { useAnnotations } from "@anaralabs/lector";
import { useCallback, useState } from "react";

interface UseAnnotationActionsProps {
	annotation: Annotation;
	onClose?: () => void;
}

interface UseAnnotationActionsReturn {
	comment: string;
	isEditing: boolean;
	setComment: (comment: string) => void;
	setIsEditing: (isEditing: boolean) => void;
	handleSaveComment: () => void;
	handleColorChange: (color: string) => void;
	handleCancelEdit: () => void;
	colors: string[];
}

export const useAnnotationActions = ({
	annotation,
	onClose,
}: UseAnnotationActionsProps): UseAnnotationActionsReturn => {
	const { updateAnnotation } = useAnnotations();
	const [comment, setComment] = useState(annotation.comment || "");
	const [isEditing, setIsEditing] = useState(false);

	const handleSaveComment = useCallback(() => {
		updateAnnotation(annotation.id, { comment });
		setIsEditing(false);
		onClose?.();
	}, [annotation.id, comment, updateAnnotation, onClose]);

	const handleColorChange = useCallback(
		(color: string) => {
			updateAnnotation(annotation.id, { color, borderColor: color });
			onClose?.();
		},
		[annotation.id, updateAnnotation, onClose],
	);

	const handleCancelEdit = useCallback(() => {
		setIsEditing(false);
		onClose?.();
	}, [onClose]);

	const colors = [
		"rgba(255, 255, 0, 0.3)", // Yellow
		"rgba(0, 255, 0, 0.3)", // Green
		"rgba(255, 182, 193, 0.3)", // Pink
		"rgba(135, 206, 235, 0.3)", // Sky Blue
	];

	return {
		comment,
		isEditing,
		setComment,
		setIsEditing,
		handleSaveComment,
		handleColorChange,
		handleCancelEdit,
		colors,
	};
};
