"use client";

import {
  CanvasLayer,
  CurrentZoom,
  Page,
  Pages,
  Root,
  TextLayer,
  ZoomIn,
  ZoomOut,
  ZoomToFit,
} from "@anaralabs/lector";

import "@/lib/setup";

const fileUrl = "/pdf/large.pdf";

const ViewerZoomControl = () => {
  return (
    <Root
      source={fileUrl}
      className="bg-gray-100 border rounded-md overflow-hidden relative h-[500px] flex flex-col justify-stretch"
      loader={<div className="p-4">Loading...</div>}
    >
      <div className="bg-gray-100 border-b p-1 flex items-center justify-center text-sm text-gray-600 gap-2">
        Zoom
        <ZoomOut className="px-3 py-1 -mr-2 text-gray-900">-</ZoomOut>
        <CurrentZoom className="bg-white rounded-full px-3 py-1 border text-center w-16" />
        <ZoomIn className="px-3 py-1 -ml-2 text-gray-900">+</ZoomIn>
        <ZoomToFit className="px-3 py-1 -ml-2 text-gray-900">Fit</ZoomToFit>
      </div>
      <Pages className="p-4 h-full">
        <Page>
          <CanvasLayer />
          <TextLayer />
        </Page>
      </Pages>
    </Root>
  );
};

export default ViewerZoomControl;
