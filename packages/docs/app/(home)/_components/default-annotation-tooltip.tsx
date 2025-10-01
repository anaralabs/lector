import type { Annotation } from "@anaralabs/lector";
import { useAnnotationActions } from "./useAnnotationActions";

interface DefaultAnnotationTooltipContentProps {
	annotation: Annotation;
	onClose?: () => void;
}

export const DefaultAnnotationTooltipContent = ({
	annotation,
	onClose,
}: DefaultAnnotationTooltipContentProps) => {
	const {
		comment,
		isEditing,
		setComment,
		setIsEditing,
		handleSaveComment,
		handleColorChange,
		handleCancelEdit,
		colors,
	} = useAnnotationActions({
		annotation,
		onClose,
	});

	return (
		<div className="flex flex-col gap-2">
			{/* Color picker */}
			<div className="flex gap-2">
				{colors.map((color) => (
					<button
						key={color}
						className="w-6 h-6 rounded"
						style={{ backgroundColor: color }}
						onClick={() => handleColorChange(color)}
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
				<div>
					{annotation.comment ? (
						<div className="text-sm text-gray-700">{annotation.comment}</div>
					) : (
						<button
							onClick={() => setIsEditing(true)}
							className="text-sm text-blue-500 hover:text-blue-600"
						>
							Add comment
						</button>
					)}
				</div>
			)}
		</div>
	);
};
