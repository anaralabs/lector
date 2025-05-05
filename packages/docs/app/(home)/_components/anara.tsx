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
} from "@anaralabs/lector";
import React, { useCallback, useEffect } from "react";
import "pdfjs-dist/web/pdf_viewer.css";

import { GlobalWorkerOptions } from "pdfjs-dist";
import ZoomMenu from "./zoom-menu";
import DocumentMenu from "./document-menu";
import { PageNavigation } from "./page-navigation";

const fileUrl = "/pdf/pathways.pdf";
const STORAGE_KEY = "pdf-annotations";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();


const SelectionTooltipContent = ({ onHighlight }: { onHighlight: () => void }) => {
  return (
    <button
      className="bg-white shadow-lg rounded-md px-3 py-1 hover:bg-yellow-200/70"
      onClick={onHighlight}
    >
      Add Annotation
    </button>
  );
};

interface PDFContentProps {
  onAnnotationsChange: (annotations: Annotation[]) => void;
  initialAnnotations?: Annotation[];
}

const PDFContent = ({ onAnnotationsChange, initialAnnotations }: PDFContentProps) => {
  const { addAnnotation, annotations, setAnnotations } = useAnnotations();
  const { getSelection } = useSelectionDimensions();

  // Initialize annotations from props
  useEffect(() => {
    if (initialAnnotations?.length) {
      setAnnotations(initialAnnotations);
    }
  }, [initialAnnotations, setAnnotations]);

  // Update parent component when annotations change
  useEffect(() => {
    onAnnotationsChange(annotations);
  }, [annotations, onAnnotationsChange]);

  const handleCreateAnnotation = useCallback(() => {
    const selection = getSelection();
    if (!selection || !selection.highlights.length) return;

    addAnnotation({
      pageNumber: selection.highlights[0].pageNumber,
      highlights: selection.highlights,
      color: "rgba(255, 255, 0, 0.3)", // Default yellow color
    });

    // Clear the selection
    window.getSelection()?.removeAllRanges();
  }, [addAnnotation, getSelection]);

  return (
    <Pages className="dark:invert-[94%] dark:hue-rotate-180 dark:brightness-[80%] dark:contrast-[228%] dark:bg-gray-100">
      <Page>
        <CanvasLayer />
        <TextLayer />
        <AnnotationHighlightLayer />
        <SelectionTooltip>
          <SelectionTooltipContent onHighlight={handleCreateAnnotation} />
        </SelectionTooltip>
      </Page>
    </Pages>
  );
};

export const AnaraViewer = () => {
  const [savedAnnotations, setSavedAnnotations] = React.useState<Annotation[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);

  // Load annotations from localStorage on mount
  useEffect(() => {
    const loadAnnotations = () => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          // Parse dates back into Date objects
          const annotations = JSON.parse(saved, (key, value) => {
            if (key === 'createdAt' || key === 'updatedAt') {
              return new Date(value);
            }
            return value;
          });
          setSavedAnnotations(annotations);
        }
      } catch (error) {
        console.error('Error loading annotations:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadAnnotations();
  }, []);

  // Handle annotations updates
  const handleAnnotationsChange = useCallback((annotations: Annotation[]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(annotations));
      setSavedAnnotations(annotations);
    } catch (error) {
      console.error('Error saving annotations:', error);
    }
  }, []);

  if (isLoading) {
    return <div>Loading annotations...</div>;
  }

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
      <PDFContent 
        initialAnnotations={savedAnnotations}
        onAnnotationsChange={handleAnnotationsChange}
      />
    </Root>
  );
};
