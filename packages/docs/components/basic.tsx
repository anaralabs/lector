"use client";

import { CanvasLayer, Page, Pages, Root, TextLayer } from "@anaralabs/lector";
import "@/lib/setup";

const fileUrl = "/pdf/pathways.pdf";

const Basic = () => {
	return (
		<Root
			source={fileUrl}
			className="w-full h-[500px] border overflow-hidden rounded-lg"
			loader={<div className="p-4">Loading...</div>}
		>
			<Pages className="dark:invert-[94%] dark:hue-rotate-180 dark:brightness-[80%] dark:contrast-[228%]">
				<Page>
					<CanvasLayer />
					<TextLayer />
				</Page>
			</Pages>
		</Root>
	);
};

export default Basic;
