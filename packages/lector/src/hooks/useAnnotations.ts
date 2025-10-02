import { create } from "zustand";

export interface HighlightRect {
	height: number;
	left: number;
	top: number;
	width: number;
	pageNumber: number;
}

export interface Annotation {
	id: string;
	pageNumber: number;
	highlights: HighlightRect[];
	underlines?: HighlightRect[];
	color: string;
	borderColor: string;
	comment?: string;
	createdAt: Date;
	updatedAt: Date;
	metadata?: Record<string, unknown>;
	isCommentPending?: boolean;
}

interface AnnotationState {
	annotations: Annotation[];
	addAnnotation: (annotation: Annotation) => void;
	updateAnnotation: (id: string, updates: Partial<Annotation>) => void;
	deleteAnnotation: (id: string) => void;
	setAnnotations: (annotations: Annotation[]) => void;
}

export const useAnnotations = create<AnnotationState>((set) => ({
	annotations: [],
	addAnnotation: (annotation) =>
		set((state) => ({
			annotations: [...state.annotations, annotation],
		})),
	updateAnnotation: (id, updates) =>
		set((state) => ({
			annotations: state.annotations.map((annotation) =>
				annotation.id === id
					? {
							...annotation,
							...updates,
						}
					: annotation,
			),
		})),
	deleteAnnotation: (id) =>
		set((state) => ({
			annotations: state.annotations.filter(
				(annotation) => annotation.id !== id,
			),
		})),
	setAnnotations: (annotations) => set({ annotations }),
}));
