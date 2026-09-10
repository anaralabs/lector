"use client";

import {
	AnnotationLayer,
	CanvasLayer,
	Page,
	Pages,
	TextLayer,
} from "@anaralabs/lector";
import DocumentMenu from "../app/(home)/_components/document-menu";
import { PageNavigation } from "../app/(home)/_components/page-navigation";
import ZoomMenu from "../app/(home)/_components/zoom-menu";
import { ExampleRoot } from "./example-root";

const fileUrl = "/pdf/links.pdf";

const LinkDemo = () => {
	return (
		<ExampleRoot
			source={fileUrl}
			className="border not-prose overflow-hidden flex flex-col w-full h-[600px] rounded-lg"
			isZoomFitWidth={true}
			loader={<div className="w-full"></div>}
		>
			<div className="p-1 relative flex justify-between border-b">
				<ZoomMenu />
				<PageNavigation />
				<DocumentMenu documentUrl={fileUrl} />
			</div>
			<Pages className="min-h-0 flex-1" style={{ height: "auto" }}>
				<Page>
					<CanvasLayer />
					<TextLayer />
					<AnnotationLayer
						externalLinksEnabled={true}
						jumpOptions={{
							behavior: "smooth",
							align: "start",
						}}
					/>
				</Page>
			</Pages>
		</ExampleRoot>
	);
};

export default LinkDemo;
