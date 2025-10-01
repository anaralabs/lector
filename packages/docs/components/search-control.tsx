"use client";

import {
	CanvasLayer,
	HighlightLayer,
	Page,
	Pages,
	Root,
	Search,
	TextLayer,
} from "@anaralabs/lector";

import "@/lib/setup";
import { SearchUI, SearchUIFullHighlight } from "./custom-search";

const fileUrl = "/pdf/pathways.pdf";

const ViewerZoomControl = () => {
	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-col">
				<h3 className="text-lg font-semibold mb-2">
					Exact Search Term Highlighting
				</h3>
				<p className="text-sm text-gray-600 mb-4">
					This viewer highlights only the exact search term you type
				</p>
				<Root
					source={fileUrl}
					className="flex bg-gray-50 h-[500px]"
					loader={<div className="p-4">Loading...</div>}
				>
					<Search>
						<SearchUI />
					</Search>
					<Pages className="p-4 w-full">
						<Page>
							<CanvasLayer />
							<TextLayer />
							<HighlightLayer className="bg-yellow-200/70" />
						</Page>
					</Pages>
				</Root>
			</div>

			<div className="flex flex-col">
				<h3 className="text-lg font-semibold mb-2">
					Full Context Highlighting
				</h3>
				<p className="text-sm text-gray-600 mb-4">
					This viewer highlights the entire text chunk containing your search
					term
				</p>
				<Root
					source={fileUrl}
					className="flex bg-gray-50 h-[500px]"
					loader={<div className="p-4">Loading...</div>}
				>
					<Search>
						<SearchUIFullHighlight />
					</Search>
					<Pages className="p-4 w-full">
						<Page>
							<CanvasLayer />
							<TextLayer />
							<HighlightLayer className="bg-yellow-200/70" />
						</Page>
					</Pages>
				</Root>
			</div>
		</div>
	);
};

export default ViewerZoomControl;
