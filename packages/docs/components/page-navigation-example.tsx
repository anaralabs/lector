"use client";

import { CanvasLayer, Page, Pages, TextLayer } from "@anaralabs/lector";
import { ExampleRoot } from "./example-root";
import PageNavigationButtons from "./ui/page-navigation-buttons";

const fileUrl = "/pdf/large.pdf";

const PageNavigation = () => {
	return (
		<ExampleRoot
			source={fileUrl}
			className="flex bg-muted h-[500px]"
			loader={<div className="p-4">Loading...</div>}
		>
			<div className="relative min-w-0 flex-1">
				<Pages className="p-4">
					<Page>
						<CanvasLayer />
						<TextLayer />
					</Page>
				</Pages>
				<PageNavigationButtons />
			</div>
		</ExampleRoot>
	);
};

export default PageNavigation;
