"use client";

import {
  CanvasLayer,
  CurrentZoom,
  Page,
  Pages,
  Root,
  TextLayer,
  usePdf,
  ZoomIn,
  ZoomOut,
} from "@anaralabs/lector";

import "@/lib/setup";
import { useState } from "react";
import { cn } from "@/lib/utils";

const fileUrl = "/pdf/large.pdf";
function ResolutionPicker() {
  const resolution = usePdf((state) => state.resolution);
  const setResolution = usePdf((state) => state.setResolution);
  return (
    <>
      <label htmlFor="resolution">Resolution</label>
      <input
        type="number"
        value={resolution}
        onChange={(e) => setResolution(Number(e.target.value))}
        className="bg-white rounded-full px-3 py-1 border text-center w-16"
      />
    </>
  );
}
const ViewerResolutionComparison = () => {
  const [fullscreen, setFullscreen] = useState(false);
  return (
    <div
      className={cn(
        "flex flex-wrap gap-4",
        fullscreen ? "w-full h-full fixed inset-0 z-50 bg-black/50" : "",
      )}
    >
      <Root
        resolution={1}
        zoom={2}
        source={fileUrl}
        className={cn(
          "bg-gray-100 px-4 border rounded-md overflow-hidden relative flex flex-col justify-stretch w-full",
          fullscreen ? "h-full fixed inset-0 z-50" : "h-[500px]",
        )}
        loader={<div className="p-4">Loading...</div>}
      >
        <div className="bg-gray-100 border-b p-1 flex items-center justify-center text-sm text-gray-600 gap-2">
          Zoom
          <ZoomOut className="px-3 py-1 -mr-2 text-gray-900">-</ZoomOut>
          <CurrentZoom className="bg-white rounded-full px-3 py-1 border text-center w-16" />
          <ZoomIn className="px-3 py-1 -ml-2 text-gray-900">+</ZoomIn>
          <button
            onClick={() => setFullscreen(!fullscreen)}
            className="px-3 py-1 -ml-2 text-gray-900"
          >
            {fullscreen ? "Exit Fullscreen" : "Fullscreen"}
          </button>
          <ResolutionPicker />
        </div>
        <Pages className="p-4 h-full">
          <Page>
            <CanvasLayer />
            <TextLayer />
          </Page>
        </Pages>
      </Root>
    </div>
  );
};

export default ViewerResolutionComparison;
