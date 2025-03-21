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
import { SearchUI } from "./custom-search";

const fileUrl = "/pdf/large.pdf";

const ViewerZoomControl = () => {
  return (
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
  );
};

export default ViewerZoomControl;
