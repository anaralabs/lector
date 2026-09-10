"use client";

import {
	CanvasLayer,
	CurrentZoom,
	Page,
	Pages,
	TextLayer,
	ZoomIn,
	ZoomOut,
} from "@anaralabs/lector";

import { ExampleRoot } from "./example-root";

const fileUrl = "/lector/pdf/large.pdf";

const ViewerZoomControl = () => {
	return (
		<ExampleRoot
			source={fileUrl}
			className="bg-muted border rounded-md overflow-hidden relative h-[500px] flex flex-col justify-stretch"
			loader={<div className="p-4">Loading...</div>}
		>
			<div className="bg-muted border-b p-1 flex items-center justify-center text-sm text-muted-foreground gap-2">
				Zoom
				<ZoomOut
					type="button"
					aria-label="Zoom out"
					className="px-3 py-1 -mr-2 text-foreground"
				>
					-
				</ZoomOut>
				<CurrentZoom
					aria-label="Zoom percentage"
					className="bg-background rounded-full px-3 py-1 border text-center w-16"
				/>
				<ZoomIn
					type="button"
					aria-label="Zoom in"
					className="px-3 py-1 -ml-2 text-foreground"
				>
					+
				</ZoomIn>
			</div>
			<Pages className="p-4 min-h-0 flex-1" style={{ height: "auto" }}>
				<Page>
					<CanvasLayer />
					<TextLayer />
				</Page>
			</Pages>
		</ExampleRoot>
	);
};

export default ViewerZoomControl;
