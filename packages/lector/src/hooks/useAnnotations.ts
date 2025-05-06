import { v4 as uuidv4 } from "uuid";
import { create } from "zustand";

export interface Annotation {
  id: string;
  pageNumber: number;
  highlights: Array<{
    height: number;
    left: number;
    top: number;
    width: number;
    pageNumber: number;
  }>;
  comment?: string;
  color?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface AnnotationState {
  annotations: Annotation[];
  addAnnotation: (annotation: Omit<Annotation, "id" | "createdAt" | "updatedAt">) => void;
  updateAnnotation: (id: string, updates: Partial<Annotation>) => void;
  deleteAnnotation: (id: string) => void;
  setAnnotations: (annotations: Annotation[]) => void;
  addPDFAnnotations: (pageNumber: number, pdfAnnotations: any[]) => void;
}

export const useAnnotations = create<AnnotationState>((set) => ({
  annotations: [],
  addAnnotation: (annotation) =>
    set((state) => ({
      annotations: [
        ...state.annotations,
        {
          ...annotation,
          id: uuidv4(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })),
  updateAnnotation: (id, updates) =>
    set((state) => ({
      annotations: state.annotations.map((annotation) =>
        annotation.id === id
          ? {
            ...annotation,
            ...updates,
            updatedAt: new Date(),
          }
          : annotation
      ),
    })),
  deleteAnnotation: (id) =>
    set((state) => ({
      annotations: state.annotations.filter((annotation) => annotation.id !== id),
    })),
  setAnnotations: (annotations) => set({ annotations }),
  addPDFAnnotations: (pageNumber: number, pdfAnnotations: any[]) =>
    set((state) => {
      const newAnnotations = pdfAnnotations.map(pdfAnnotation => ({
        id: uuidv4(),
        pageNumber,
        highlights: [{
          height: pdfAnnotation.rect[3] - pdfAnnotation.rect[1],
          width: pdfAnnotation.rect[2] - pdfAnnotation.rect[0],
          top: pdfAnnotation.rect[1],
          left: pdfAnnotation.rect[0],
          pageNumber
        }],
        createdAt: new Date(),
        updatedAt: new Date()
      }));

      // Filter out any existing PDF annotations for this page
      const filteredAnnotations = state.annotations.filter(
        ann => !(ann.pageNumber === pageNumber)
      );

      return {
        annotations: [...filteredAnnotations, ...newAnnotations]
      };
    }),
})); 