"use client";

import { CanvasLayer, Page, Pages, Root, TextLayer } from "@anaralabs/lector";
import { useTheme } from "next-themes";
import "@/lib/setup";

const fileUrl = "/pdf/pathways.pdf";

const Basic = () => {
	const { resolvedTheme } = useTheme();

	return (
		<Root
			source={fileUrl}
			className="w-full h-[500px] border overflow-hidden rounded-lg"
			loader={<div className="p-4">Loading...</div>}
			colorScheme={resolvedTheme === "dark" ? "dark" : "light"}
		>
			<Pages>
				<Page>
					<CanvasLayer />
					<TextLayer />
				</Page>
			</Pages>
		</Root>
	);
};

export default Basic;
