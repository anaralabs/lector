import { SelectionTooltip } from "@anaralabs/lector";

export const CustomSelect = ({ onHighlight }: { onHighlight: () => void }) => {
	return (
		<SelectionTooltip>
			<button
				className="bg-white shadow-lg rounded-md px-3 py-1 hover:bg-yellow-200/70"
				onClick={onHighlight}
			>
				Highlight
			</button>
		</SelectionTooltip>
	);
};
