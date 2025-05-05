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

interface AnnotationListProps {
  annotations: Annotation[];
  focusedAnnotationId?: string;
  onAnnotationClick: (annotation: Annotation | null) => void;
}

const AnnotationList = ({ annotations, focusedAnnotationId, onAnnotationClick }: AnnotationListProps) => {
  return (
    <div className="h-32 border overflow-y-auto bg-white rounded-lg">
      <div className="p-2">
        <h3 className="font-semibold mb-2">Annotations</h3>
        <div className="space-y-2">
          {annotations.map((annotation) => (
            <div
              key={annotation.id}
              className={`p-2 rounded cursor-pointer transition-colors ${
                focusedAnnotationId === annotation.id
                  ? 'bg-yellow-100'
                  : 'hover:bg-gray-100'
              }`}
              onClick={() => onAnnotationClick(annotation)}
            >
              <div className="flex items-center gap-2">
                <div
                  className="w-4 h-4 rounded"
                  style={{ backgroundColor: annotation.color }}
                />
                <div className="flex-grow">
                  <div className="text-sm">
                    {annotation.comment || 'No comment'}
                  </div>
                  <div className="text-xs text-gray-500">
                    Page {annotation.pageNumber}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

interface PDFContentProps {
  onAnnotationsChange: (annotations: Annotation[]) => void;
  initialAnnotations?: Annotation[];
  focusedAnnotationId?: string;
  onAnnotationClick: (annotation: Annotation | null) => void;
}

interface TooltipContentProps {
  annotation: Annotation;
  onClose: () => void;
}

const TooltipContent = ({ annotation, onClose }: TooltipContentProps) => {
  const { updateAnnotation, deleteAnnotation } = useAnnotations();
  const [comment, setComment] = useState(annotation.comment || "");
  const [isEditing, setIsEditing] = useState(false);

  const handleSaveComment = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    updateAnnotation(annotation.id, { comment });
    setIsEditing(false);
    onClose?.();
  }, [annotation.id, comment, updateAnnotation, onClose]);

  const handleColorChange = useCallback((e: React.MouseEvent, color: string) => {
    e.stopPropagation();
    updateAnnotation(annotation.id, { color });
    onClose?.();
  }, [annotation.id, updateAnnotation, onClose]);

  const handleStartEditing = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
  }, []);

  const handleCancelEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(false);
  }, []);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    deleteAnnotation(annotation.id);
    onClose?.();
  }, [annotation.id, deleteAnnotation, onClose]);

  const colors = [
    "rgba(255, 255, 0, 0.3)", // Yellow
    "rgba(0, 255, 0, 0.3)", // Green
    "rgba(255, 182, 193, 0.3)", // Pink
    "rgba(135, 206, 235, 0.3)", // Sky Blue
  ];

  const handleTooltipClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div className="flex flex-col gap-2" onClick={handleTooltipClick}>
      {/* Color picker and delete button */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {colors.map((color) => (
            <button
              key={color}
              className="w-6 h-6 rounded"
              style={{ backgroundColor: color }}
              onClick={(e) => handleColorChange(e, color)}
            />
          ))}
        </div>
        <button
          onClick={handleDelete}
          className="text-sm text-red-500 hover:text-red-600"
        >
          Delete
        </button>
      </div>

      {/* Comment section */}
      {isEditing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="border rounded p-2 text-sm"
            placeholder="Add a comment..."
            rows={3}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={handleCancelEdit}
              className="px-2 py-1 text-sm text-gray-600 hover:text-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveComment}
              className="px-2 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div>
          {annotation.comment ? (
            <div className="text-sm text-gray-700">{annotation.comment}</div>
          ) : (
            <button
              onClick={handleStartEditing}
              className="text-sm text-blue-500 hover:text-blue-600"
            >
              Add comment
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const PDFContent = ({ 
  onAnnotationsChange, 
  initialAnnotations,
  focusedAnnotationId,
  onAnnotationClick,
}: PDFContentProps) => {
  const { addAnnotation, annotations, setAnnotations } = useAnnotations();
  const { getSelection } = useSelectionDimensions();
  const { jumpToHighlightRects } = usePdfJump();

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

    // Create the new annotation
    const newAnnotation = {
      pageNumber: selection.highlights[0].pageNumber,
      highlights: selection.highlights,
      color: "rgba(255, 255, 0, 0.3)", // Default yellow color
    };

    // Add the annotation
    addAnnotation(newAnnotation);

    // Clear the selection to hide the selection tooltip
    window.getSelection()?.removeAllRanges();
  }, [addAnnotation, getSelection]);

  // Focus newly created annotations
  useEffect(() => {
    if (annotations.length === 0) return;
    
    const lastAnnotation = annotations[annotations.length - 1];
    const isNewAnnotation = Date.now() - new Date(lastAnnotation.createdAt).getTime() < 1000;
    
    if (isNewAnnotation) {
      onAnnotationClick(lastAnnotation);
    }
  }, [annotations, onAnnotationClick]);

  // Scroll to annotation when focused
  useEffect(() => {
    if (!focusedAnnotationId) return;

    const annotation = annotations.find(a => a.id === focusedAnnotationId);
    if (!annotation || !annotation.highlights.length) return;

    jumpToHighlightRects(
      annotation.highlights,
      "pixels",
      "center", // Center the highlight in the viewport
      -50 // Small offset from center for better visibility
    );
  }, [focusedAnnotationId, annotations, jumpToHighlightRects]);

  const handlePagesClick = useCallback((e: React.MouseEvent) => {
    // Get the clicked element and check what was clicked
    const target = e.target as HTMLElement;
    
    // Check if we clicked inside a tooltip or its children
    if (target.closest('[role="tooltip"]')) {
      return; // Don't do anything if clicking inside tooltip
    }

    // Check if we clicked on a highlight
    const clickedHighlight = target.closest('[data-highlight-id]');
    
    // If we clicked on a highlight, let the AnnotationHighlightLayer handle it
    if (clickedHighlight) {
      return;
    }

    // If we clicked anywhere else (not tooltip, not highlight), clear focus
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
  const [savedAnnotations, setSavedAnnotations] = React.useState<Annotation[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string>();

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

  const handleAnnotationClick = useCallback((annotation: Annotation | null) => {
    setFocusedAnnotationId(annotation?.id);
  }, []);

  if (isLoading) {
    return <div>Loading annotations...</div>;
  }

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
      <AnnotationList 
        annotations={savedAnnotations}
        focusedAnnotationId={focusedAnnotationId}
        onAnnotationClick={handleAnnotationClick}
      />
    </div>
  );
};
