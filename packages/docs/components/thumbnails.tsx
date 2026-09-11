"use client";

import {
	CanvasLayer,
	CurrentPage,
	CurrentZoom,
	Page,
	Pages,
	TextLayer,
	Thumbnail,
	Thumbnails,
	ZoomIn,
	ZoomOut,
} from "@anaralabs/lector";
import { cn } from "fumadocs-ui/components/api";
import { useState } from "react";

import { ExampleRoot } from "./example-root";

const fileUrl = "/lector/pdf/pathways.pdf";

const WithThumbnails = () => {
	const [showThumbnails, setShowThumbnails] = useState(true);

	return (
		<ExampleRoot
			source={fileUrl}
			className="bg-muted border rounded-md overflow-hidden relative h-[700px] flex flex-col justify-stretch"
			loader={<div className="p-4">Loading...</div>}
		>
			<div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted p-2 text-sm text-muted-foreground">
				<button
					type="button"
					onClick={() => setShowThumbnails((show) => !show)}
					className="rounded-full px-2 py-1 hover:bg-accent hover:text-foreground"
				>
					{showThumbnails ? "Hide" : "Show"} Thumbnails
				</button>
				<label className="flex items-center gap-2 whitespace-nowrap">
					Page
					<CurrentPage className="w-14 rounded-full border bg-background px-2 py-1 text-center" />
				</label>
				<div className="flex items-center gap-2 whitespace-nowrap">
					<span>Zoom</span>
					<ZoomOut
						type="button"
						aria-label="Zoom out"
						className="px-2 py-1 text-foreground"
					>
						−
					</ZoomOut>
					<CurrentZoom
						aria-label="Zoom percentage"
						className="w-14 rounded-full border bg-background px-2 py-1 text-center"
					/>
					<ZoomIn
						type="button"
						aria-label="Zoom in"
						className="px-2 py-1 text-foreground"
					>
						+
					</ZoomIn>
				</div>
			</div>
			<div
				className={cn(
					"basis-0 grow min-h-0 min-w-0 relative grid",
					"transition-all duration-300",
					showThumbnails
						? "grid-cols-[7rem_minmax(0,1fr)]"
						: "grid-cols-[0_minmax(0,1fr)]",
				)}
			>
				<div className="overflow-y-auto overflow-x-hidden">
					<div className="w-28 overflow-x-hidden">
						<Thumbnails className="flex flex-col gap-4 items-center py-4">
							<Thumbnail className="transition-all w-20 hover:shadow-lg hover:outline hover:outline-gray-300" />
						</Thumbnails>
					</div>
				</div>
				<Pages className="p-4 h-full min-w-0">
					<Page>
						<CanvasLayer />
						<TextLayer />
					</Page>
				</Pages>
			</div>
		</ExampleRoot>
	);
};

export default WithThumbnails;
