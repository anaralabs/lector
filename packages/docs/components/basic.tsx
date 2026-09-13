"use client";

import { CanvasLayer, Page, Pages, TextLayer } from "@anaralabs/lector";
import { ExampleRoot } from "./example-root";

const fileUrl = "/lector/pdf/pathways.pdf";

const Basic = () => {
	return (
		<ExampleRoot
			source={fileUrl}
			className="w-full h-[500px] border overflow-hidden rounded-lg"
			loader={<div className="p-4">Loading...</div>}
		>
			<Pages>
				<Page>
					<CanvasLayer />
					<TextLayer />
				</Page>
			</Pages>
		</ExampleRoot>
	);
};

export default Basic;
