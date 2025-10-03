"use client";

import { CanvasLayer, Page, Pages, Root, TextLayer } from "@anaralabs/lector";
import PageNavigationButtons from "./ui/page-navigation-buttons";
import "@/lib/setup";

const fileUrl = "/pdf/large.pdf";

const PageNavigation = () => {
	return (
		<Root
			source={fileUrl}
			className="flex bg-gray-50 h-[500px]"
			loader={<div className="p-4">Loading...</div>}
		>
			<div className="relative flex-1">
				<Pages className="p-4">
					<Page>
						<CanvasLayer />
						<TextLayer />
					</Page>
				</Pages>
				<PageNavigationButtons />
			</div>
		</Root>
	);
};

export default PageNavigation;
