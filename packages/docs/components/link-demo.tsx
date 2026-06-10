"use client";

import {
	AnnotationLayer,
	CanvasLayer,
	Page,
	Pages,
	Root,
	TextLayer,
} from "@anaralabs/lector";
import { useTheme } from "next-themes";
import "@/lib/setup";
import DocumentMenu from "../app/(home)/_components/document-menu";
import { PageNavigation } from "../app/(home)/_components/page-navigation";
import ZoomMenu from "../app/(home)/_components/zoom-menu";

const fileUrl = "/pdf/links.pdf";

const LinkDemo = () => {
	const { resolvedTheme } = useTheme();

	return (
		<Root
			source={fileUrl}
			className="border not-prose overflow-hidden flex flex-col w-full h-[600px] rounded-lg"
			isZoomFitWidth={true}
			loader={<div className="w-full"></div>}
			colorScheme={resolvedTheme === "dark" ? "dark" : "light"}
		>
			<div className="p-1 relative flex justify-between border-b">
				<ZoomMenu />
				<PageNavigation />
				<DocumentMenu documentUrl={fileUrl} />
			</div>
			<Pages>
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
