"use client";

import { 
  CanvasLayer, 
  Page, 
  Pages, 
  Root, 
  TextLayer, 
  AnnotationHighlightLayer, 
  type Annotation,
  SelectionTooltip,
  useAnnotations,
  useSelectionDimensions,
  usePdfJump,
} from "@anaralabs/lector";
import React, { useCallback, useEffect, useState } from "react";
import "pdfjs-dist/web/pdf_viewer.css";

import { GlobalWorkerOptions } from "pdfjs-dist";
import ZoomMenu from "./zoom-menu";
import DocumentMenu from "./document-menu";
import { PageNavigation } from "./page-navigation";
import { SelectionTooltipContent, TooltipContent, TooltipContentProps } from "./annotationts";

const fileUrl = "/pdf/pathways.pdf";
const STORAGE_KEY = "pdf-annotations";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

interface PDFContentProps {
  onAnnotationsChange: (annotations: Annotation[]) => void;
  initialAnnotations?: Annotation[];
  focusedAnnotationId?: string;
  onAnnotationClick: (annotation: Annotation | null) => void;
}


const PDFContent = ({ 
  onAnnotationsChange, 
  focusedAnnotationId,
  onAnnotationClick,
}: PDFContentProps) => {
  const { addAnnotation, annotations } = useAnnotations();
  const { getDimension } = useSelectionDimensions();
  const { jumpToHighlightRects } = usePdfJump();


  useEffect(() => {
    onAnnotationsChange(annotations);
  }, [annotations, onAnnotationsChange]);

  const handleCreateAnnotation = useCallback(() => {
    const selection = getDimension();
    if (!selection || !selection.highlights.length) return;

    const newAnnotation = {
      pageNumber: selection.highlights[0].pageNumber,
      highlights: selection.highlights,
      color: "rgba(255, 255, 0, 0.3)", 
      text: selection.text,
    };

    addAnnotation(newAnnotation);
    window.getSelection()?.removeAllRanges();
  }, [addAnnotation, getSelection]);

  useEffect(() => {
    if (annotations.length === 0) return;
    
    const lastAnnotation = annotations[annotations.length - 1];
    const isNewAnnotation = Date.now() - new Date(lastAnnotation.createdAt).getTime() < 1000;
    
    if (isNewAnnotation) {
      onAnnotationClick(lastAnnotation);
    }
  }, [annotations, onAnnotationClick]);

  useEffect(() => {
    if (!focusedAnnotationId) return;

    const annotation = annotations.find(a => a.id === focusedAnnotationId);
    if (!annotation || !annotation.highlights.length) return;

    jumpToHighlightRects(
      annotation.highlights,
      "pixels",
      "center", 
      -50 
    );
  }, [focusedAnnotationId, annotations, jumpToHighlightRects]);

  const handlePagesClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    
    if (target.closest('[role="tooltip"]')) {
      return; 
    }

    const clickedHighlight = target.closest('[data-highlight-id]');
    
    // If we clicked on a highlight, let the AnnotationHighlightLayer handle it
    if (clickedHighlight) {
      return;
    }

    if (focusedAnnotationId) {
      onAnnotationClick(null);
    }
  }, [focusedAnnotationId, onAnnotationClick]);

  const renderTooltipContent = useCallback(({ annotation, onClose }: TooltipContentProps) => {
    return <TooltipContent annotation={annotation} onClose={onClose} />;
  }, []);

  return (
    <Pages 
      className="dark:invert-[94%] dark:hue-rotate-180 dark:brightness-[80%] dark:contrast-[228%] dark:bg-gray-100"
      onClick={handlePagesClick}
    >
      <Page>
        <CanvasLayer />
        <TextLayer />
        <AnnotationHighlightLayer 
          focusedAnnotationId={focusedAnnotationId}
          tooltipClassName="bg-white shadow-lg rounded-lg p-3 min-w-[200px]"
          onAnnotationClick={onAnnotationClick}
          renderTooltipContent={renderTooltipContent}
        />
        <SelectionTooltip>
          <SelectionTooltipContent onHighlight={handleCreateAnnotation} />
        </SelectionTooltip>
      </Page>
    </Pages>
  );
};

export const AnaraViewer = () => {
  const [savedAnnotations, setSavedAnnotations] = React.useState<Annotation[]>([]);
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string>();

  const handleAnnotationsChange = useCallback((annotations: Annotation[]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(annotations));
      setSavedAnnotations(annotations);
    } catch (error) {
      console.error('Error saving annotations:', error);
    }
  }, []);

  const handleAnnotationClick = useCallback((annotation: Annotation | null) => {
    setFocusedAnnotationId(annotation?.id);
  }, []);

  return (
    <div className="flex flex-col gap-4">
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
        <PDFContent 
          initialAnnotations={savedAnnotations}
          onAnnotationsChange={handleAnnotationsChange}
          focusedAnnotationId={focusedAnnotationId}
          onAnnotationClick={handleAnnotationClick}
        />
      </Root>
    </div>
  );
};
