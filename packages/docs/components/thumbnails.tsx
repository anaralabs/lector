"use client";

import {
	CanvasLayer,
	CurrentPage,
	CurrentZoom,
	Page,
	Pages,
	Root,
	TextLayer,
	Thumbnail,
	Thumbnails,
	ZoomIn,
	ZoomOut,
} from "@anaralabs/lector";
import { cn } from "fumadocs-ui/components/api";
import { useState } from "react";

import "@/lib/setup";

const fileUrl = "/pdf/pathways.pdf";

const WithThumbnails = () => {
	const [showThumbnails, setShowThumbnails] = useState(true);

	return (
		<Root
			source={fileUrl}
			className="bg-gray-100 border rounded-md overflow-hidden relative h-[700px] flex flex-col justify-stretch"
			loader={<div className="p-4">Loading...</div>}
		>
			<div className="bg-gray-100 border-b p-1 flex items-center justify-center text-sm text-gray-600 gap-2">
				<button
					onClick={() => setShowThumbnails((showOutline) => !showOutline)}
					className="px-2 hover:bg-gray-300 hover:text-gray-900 py-1 rounded-full"
				>
					{showThumbnails ? "Hide" : "Show"} Thumbnails
				</button>
				<span className="flex-grow" />
				Page
				<CurrentPage className="bg-white rounded-full px-3 py-1 border text-center" />
				Zoom
				<ZoomOut className="px-3 py-1 -mr-2 text-gray-900">-</ZoomOut>
				<CurrentZoom className="bg-white rounded-full px-3 py-1 border text-center w-16" />
				<ZoomIn className="px-3 py-1 -ml-2 text-gray-900">+</ZoomIn>
				<span className="flex-grow" />
			</div>
			<div
				className={cn(
					"basis-0 grow min-h-0 relative grid",
					"transition-all duration-300",
					showThumbnails ? "grid-cols-[24rem,1fr]" : "grid-cols-[0,1fr]",
				)}
			>
				<div className="overflow-y-auto overflow-x-hidden">
					<div className="w-96 overflow-x-hidden">
						<Thumbnails className="flex flex-col gap-4 items-center py-4">
							<Thumbnail className="transition-all w-48 hover:shadow-lg hover:outline hover:outline-gray-300" />
						</Thumbnails>
					</div>
				</div>
				<Pages className="p-4 h-full">
					<Page>
						<CanvasLayer />
						<TextLayer />
					</Page>
				</Pages>
			</div>
		</Root>
	);
};

export default WithThumbnails;
