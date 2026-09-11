"use client";

import { CanvasLayer, Page, Pages, TextLayer } from "@anaralabs/lector";
import { ExampleRoot } from "./example-root";

const fileUrl = "/lector/pdf/large.pdf";

const BasicTextLayer = () => {
	return (
		<ExampleRoot
			source={fileUrl}
			className="bg-muted border rounded-md overflow-hidden relative h-[500px]"
			loader={<div className="p-4">Loading...</div>}
		>
			<Pages className="p-4 h-full">
				<Page>
					<CanvasLayer />
					<TextLayer />
				</Page>
			</Pages>
		</ExampleRoot>
	);
};

export default BasicTextLayer;
