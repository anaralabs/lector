"use client";

import { 
  CanvasLayer, 
  Page, 
  Pages, 
  Root, 
  TextLayer, 
  AnnotationHighlightLayer,
  SelectionTooltip,
  useSelectionDimensions,
  usePdfJump,
  usePdf,
  Annotation,
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


// Helper function to load annotations from localStorage
const loadAnnotations = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? (JSON.parse(saved) as Annotation[]) : [];
  } catch (error) {
    console.error('Error loading annotations:', error);
    return [];
  }
};

// Helper function to save annotations to localStorage
const saveAnnotations = (annotations: Annotation[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(annotations));
  } catch (error) {
    console.error('Error saving annotations:', error);
  }
};

const usePersistedAnnotations = () => {
  const annotations = usePdf(state => state.annotations);
  const setAnnotations = usePdf(state => state.setAnnotations);
  const addAnnotation = usePdf(state => state.addAnnotation);
  const updateAnnotation = usePdf(state => state.updateAnnotation);
  const removeAnnotation = usePdf(state => state.removeAnnotation);

  // Load saved annotations on mount
  useEffect(() => {
    const savedAnnotations = loadAnnotations();
    if (savedAnnotations.length > 0) {
      setAnnotations(savedAnnotations);
    }
  }, [setAnnotations]);

  // Save annotations whenever they change
  useEffect(() => {
    saveAnnotations(annotations);
  }, [annotations]);

  return {
    annotations,
    setAnnotations,
    addAnnotation,
    updateAnnotation,
    removeAnnotation
  };
};

const PDFContent = ({ 
  focusedAnnotationId,
  onAnnotationClick,
}: {
  focusedAnnotationId?: string;
  onAnnotationClick: (annotation: Annotation | null) => void;
}) => {
  const { getDimension } = useSelectionDimensions();
  const { jumpToHighlightRects } = usePdfJump();
  const { annotations, addAnnotation } = usePersistedAnnotations();

  const handleCreateAnnotation = useCallback(() => {
    const selection = getDimension();
    if (!selection || !selection.highlights.length) return;

    const highlight = selection.highlights[0];
    const newAnnotation: Annotation = {
      id: Math.random().toString(36).substring(7),
      pageNumber: highlight.pageNumber,
      highlights: selection.highlights,
      color: "rgba(255, 255, 0, 0.3)",
      comment: selection.text,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    addAnnotation(newAnnotation);
    onAnnotationClick(newAnnotation);
    window.getSelection()?.removeAllRanges();
  }, [getDimension, addAnnotation, onAnnotationClick]);

  useEffect(() => {
    if (!focusedAnnotationId) return;

    const jumpToAnnotation = (annotation: Annotation) => {
      const highlight = {
        pageNumber: annotation.pageNumber,
        top: annotation.highlights[0].top,
        left: annotation.highlights[0].left,
        width: annotation.highlights[0].width,
        height: annotation.highlights[0].height,
      };

      jumpToHighlightRects(
        [highlight],
        "pixels",
        "center", 
        -50 
      );
    };

    const annotation = annotations.find((a: Annotation) => a.id === focusedAnnotationId);
    if (annotation) {
      jumpToAnnotation(annotation);
    }
  }, [focusedAnnotationId, jumpToHighlightRects, annotations]);

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
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string>();

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
          focusedAnnotationId={focusedAnnotationId}
          onAnnotationClick={handleAnnotationClick}
        />
      </Root>
    </div>
  );
};
