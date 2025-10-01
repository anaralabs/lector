"use client";

import {
	CanvasLayer,
	HighlightLayer,
	Page,
	Pages,
	Root,
	TextLayer,
	usePdf,
	useSelectionDimensions,
} from "@anaralabs/lector";

import "@/lib/setup";
import { CustomSelect } from "./custom-select";

const fileUrl = "/pdf/pathways.pdf";

const HighlightLayerContent = () => {
	const selectionDimensions = useSelectionDimensions();
	const setHighlights = usePdf((state) => state.setHighlight);

	const handleHighlight = () => {
		const dimension = selectionDimensions.getDimension();
		if (dimension && !dimension.isCollapsed) {
			setHighlights(dimension.highlights);
		}
	};

	return (
		<Pages className="p-4 w-full">
			<Page>
				{selectionDimensions && <CustomSelect onHighlight={handleHighlight} />}
				<CanvasLayer />
				<TextLayer />
				<HighlightLayer className="bg-yellow-200/70" />
			</Page>
		</Pages>
	);
};

const PdfHighlightSelect = () => (
	<Root
		source={fileUrl}
		className="flex bg-gray-50 h-[500px]"
		loader={<div className="p-4">Loading...</div>}
	>
		<HighlightLayerContent />
	</Root>
);

export default PdfHighlightSelect;
