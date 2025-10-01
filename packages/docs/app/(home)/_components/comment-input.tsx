import type React from "react";
import { useCallback, useState } from "react";

interface CommentInputProps {
	onSave: (comment: string) => void;
	onCancel: () => void;
	placeholder?: string;
}

export const CommentInput = ({
	onSave,
	onCancel,
	placeholder = "Add your comment...",
}: CommentInputProps) => {
	const [comment, setComment] = useState("");

	const handleSave = useCallback(() => {
		if (comment.trim()) {
			onSave(comment.trim());
		}
	}, [comment, onSave]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				handleSave();
			} else if (e.key === "Escape") {
				e.preventDefault();
				onCancel();
			}
		},
		[handleSave, onCancel],
	);

	return (
		<div className="bg-background shadow-lg rounded-lg p-3 min-w-[250px]">
			<textarea
				value={comment}
				onChange={(e) => setComment(e.target.value)}
				placeholder={placeholder}
				className="w-full border rounded p-2 text-sm resize-none"
				rows={3}
				onKeyDown={handleKeyDown}
				autoFocus
			/>
			<div className="flex justify-end gap-2 mt-2">
				<button
					onClick={onCancel}
					className="px-3 py-1 text-sm text-gray-600 hover:text-gray-800"
				>
					Cancel
				</button>
				<button
					onClick={handleSave}
					disabled={!comment.trim()}
					className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
				>
					Save
				</button>
			</div>
			<div className="text-xs text-gray-500 mt-1">
				Press Cmd+Enter to save, Esc to cancel
			</div>
		</div>
	);
};
