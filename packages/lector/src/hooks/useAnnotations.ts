import React from "react";
import { createStore, type StoreApi, useStore } from "zustand";

import { createZustandContext } from "../lib/zustand";

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

type AnnotationStoreApi = StoreApi<AnnotationState>;

const createAnnotationStore = (): AnnotationStoreApi =>
	createStore<AnnotationState>((set) => ({
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

const AnnotationsStore = createZustandContext<void, AnnotationStoreApi>(() =>
	createAnnotationStore(),
);

// Lazy module-level fallback: preserves pre-context behavior for any
// consumer that hasn't wrapped their tree in AnnotationsStoreProvider.
let fallbackStore: AnnotationStoreApi | null = null;
const getFallbackStore = (): AnnotationStoreApi => {
	if (!fallbackStore) fallbackStore = createAnnotationStore();
	return fallbackStore;
};

export const AnnotationsStoreProvider = ({
	children,
}: {
	children?: React.ReactNode;
}) =>
	React.createElement(
		AnnotationsStore.Provider,
		{ initialValue: undefined as never },
		children,
	);

export const useAnnotations = (): AnnotationState => {
	const ctx = AnnotationsStore.useContext();
	return useStore(ctx ?? getFallbackStore());
};
