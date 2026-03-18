"use client";

import {
	AnnotationLayer,
	CanvasLayer,
	Page,
	Pages,
	Root,
	TextLayer,
} from "@anaralabs/lector";
import "pdfjs-dist/web/pdf_viewer.css";
import DocumentMenu from "../app/(home)/_components/document-menu";
import { PageNavigation } from "../app/(home)/_components/page-navigation";
import ZoomMenu from "../app/(home)/_components/zoom-menu";

const fileUrl = "/pdf/links.pdf";

const LinkDemo = () => {
	return (
		<Root
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
			<Pages className="dark:invert-[94%] dark:hue-rotate-180 dark:brightness-[80%] dark:contrast-[228%] dark:bg-gray-100">
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
		</Root>
	);
};

export default LinkDemo;
