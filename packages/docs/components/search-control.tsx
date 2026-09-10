"use client";

import {
	CanvasLayer,
	HighlightLayer,
	Page,
	Pages,
	Search,
	TextLayer,
} from "@anaralabs/lector";
import { SearchUI, SearchUIFullHighlight } from "./custom-search";
import { ExampleRoot } from "./example-root";

const fileUrl = "/lector/pdf/pathways.pdf";

const ViewerZoomControl = () => {
	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-col">
				<h3 className="text-lg font-semibold mb-2">
					Exact Search Term Highlighting
				</h3>
				<p className="text-sm text-muted-foreground mb-4">
					This viewer highlights only the exact search term you type
				</p>
				<ExampleRoot
					source={fileUrl}
					className="flex flex-col sm:flex-row bg-muted h-[600px]"
					loader={<div className="p-4">Loading...</div>}
				>
					<Search>
						<SearchUI />
					</Search>
					<Pages className="p-4 min-h-0 min-w-0 flex-1">
						<Page>
							<CanvasLayer />
							<TextLayer />
							<HighlightLayer className="bg-yellow-200/70" />
						</Page>
					</Pages>
				</ExampleRoot>
			</div>

			<div className="flex flex-col">
				<h3 className="text-lg font-semibold mb-2">
					Full Context Highlighting
				</h3>
				<p className="text-sm text-muted-foreground mb-4">
					This viewer highlights the entire text chunk containing your search
					term
				</p>
				<ExampleRoot
					source={fileUrl}
					className="flex flex-col sm:flex-row bg-muted h-[600px]"
					loader={<div className="p-4">Loading...</div>}
				>
					<Search>
						<SearchUIFullHighlight />
					</Search>
					<Pages className="p-4 min-h-0 min-w-0 flex-1">
						<Page>
							<CanvasLayer />
							<TextLayer />
							<HighlightLayer className="bg-yellow-200/70" />
						</Page>
					</Pages>
				</ExampleRoot>
			</div>
		</div>
	);
};

export default ViewerZoomControl;
