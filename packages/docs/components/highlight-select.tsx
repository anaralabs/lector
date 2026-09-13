"use client";

import {
	CanvasLayer,
	HighlightLayer,
	Page,
	Pages,
	TextLayer,
	usePdf,
	useSelectionDimensions,
} from "@anaralabs/lector";
import { CustomSelect } from "./custom-select";
import { ExampleRoot } from "./example-root";

const fileUrl = "/lector/pdf/pathways.pdf";

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
	<ExampleRoot
		source={fileUrl}
		className="flex bg-muted h-[500px]"
		loader={<div className="p-4">Loading...</div>}
	>
		<HighlightLayerContent />
	</ExampleRoot>
);

export default PdfHighlightSelect;
