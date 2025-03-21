"use client";

import { CanvasLayer, Page, Pages, Root, TextLayer } from "@anaralabs/lector";
import React from "react";
import "pdfjs-dist/web/pdf_viewer.css";

import { GlobalWorkerOptions } from "pdfjs-dist";
import ZoomMenu from "./zoom-menu";
import DocumentMenu from "./document-menu";
import { PageNavigation } from "./page-navigation";

const fileUrl = "/pdf/pathways.pdf";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

export const AnaraViewer = () => {
  return (
    <Root
      className="border overflow-hidden flex flex-col w-full h-[600px] rounded-lg"
      source={fileUrl}
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
        </Page>
      </Pages>
    </Root>
  );
};
