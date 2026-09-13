import React from "react";
import { createStore, type StoreApi, useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";

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
			set((state) => {
				const annotations = [...state.annotations, annotation];
				updatePageIndex(state.annotations, annotations, new Map(), [
					annotation,
				]);
				return { annotations };
			}),
		updateAnnotation: (id, updates) =>
			set((state) => {
				const changes = new Map<Annotation, Annotation | null>();
				const keys = Object.keys(updates) as (keyof Annotation)[];
				const annotations = state.annotations.map((annotation) => {
					if (
						annotation.id !== id ||
						keys.every((key) => Object.is(annotation[key], updates[key]))
					)
						return annotation;
					const updated = changes.get(annotation) ?? {
						...annotation,
						...updates,
					};
					changes.set(annotation, updated);
					return updated;
				});
				if (!changes.size) return state;
				updatePageIndex(state.annotations, annotations, changes);
				return { annotations };
			}),
		deleteAnnotation: (id) =>
			set((state) => {
				const changes = new Map<Annotation, Annotation | null>();
				const annotations = state.annotations.filter((annotation) => {
					if (annotation.id !== id) return true;
					changes.set(annotation, null);
					return false;
				});
				if (!changes.size) return state;
				updatePageIndex(state.annotations, annotations, changes);
				return { annotations };
			}),
		setAnnotations: (annotations) =>
			set((state) =>
				state.annotations === annotations ? state : { annotations },
			),
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

const identity = (state: AnnotationState) => state;
export function useAnnotations<T>(selector: (state: AnnotationState) => T): T;
export function useAnnotations(): AnnotationState;
export function useAnnotations<T>(selector?: (state: AnnotationState) => T) {
	const ctx = AnnotationsStore.useContext();
	return useStore(
		ctx ?? getFallbackStore(),
		(selector ?? identity) as (state: AnnotationState) => T | AnnotationState,
	);
}

const emptyAnnotations: Annotation[] = [];
const indexes = new WeakMap<Annotation[], Map<number, Annotation[]>>();
function annotationsByPage(annotations: Annotation[]) {
	let index = indexes.get(annotations);
	if (index) return index;
	index = new Map();
	for (const annotation of annotations) {
		const pages = annotationPages(annotation);
		for (const page of pages) {
			let values = index.get(page);
			if (!values) {
				values = [];
				index.set(page, values);
			}
			values.push(annotation);
		}
	}
	indexes.set(annotations, index);
	return index;
}

function annotationPages(annotation: Annotation) {
	const pages = new Set([annotation.pageNumber]);
	for (const rect of annotation.highlights) pages.add(rect.pageNumber);
	for (const rect of annotation.underlines ?? []) pages.add(rect.pageNumber);
	return pages;
}

function isOnPage(annotation: Annotation, page: number) {
	return (
		annotation.pageNumber === page ||
		annotation.highlights.some((rect) => rect.pageNumber === page) ||
		annotation.underlines?.some((rect) => rect.pageNumber === page)
	);
}

// Carry the lazy index forward through store mutations. Only affected page
// arrays change; prior snapshots remain valid for concurrent React readers.
function updatePageIndex(
	previous: Annotation[],
	next: Annotation[],
	changes: Map<Annotation, Annotation | null>,
	appended: Annotation[] = [],
) {
	const previousIndex = indexes.get(previous);
	if (!previousIndex) return;
	const index = new Map(previousIndex);
	const affected = new Set<number>();
	const movedTo = new Set<number>();
	for (const [before, after] of changes) {
		const oldPages = annotationPages(before);
		for (const page of oldPages) affected.add(page);
		if (after)
			for (const page of annotationPages(after)) {
				affected.add(page);
				if (!oldPages.has(page)) movedTo.add(page);
			}
	}
	for (const page of affected) {
		// Moving onto a new page must preserve document-array order, even for
		// duplicate IDs. Ordinary comment/color edits only visit that page's list.
		const values = movedTo.has(page)
			? next.filter((annotation) => isOnPage(annotation, page))
			: (previousIndex.get(page) ?? []).flatMap((annotation) => {
					if (!changes.has(annotation)) return [annotation];
					const updated = changes.get(annotation);
					return updated && isOnPage(updated, page) ? [updated] : [];
				});
		if (values.length) index.set(page, values);
		else index.delete(page);
	}
	for (const annotation of appended)
		for (const page of annotationPages(annotation)) {
			index.set(page, [...(index.get(page) ?? []), annotation]);
		}
	indexes.set(next, index);
}

// One index per immutable annotation array, and stable results for pages whose
// annotation objects have not changed. Cross-page highlights/underlines count.
export function usePageAnnotations(pageNumber: number) {
	return useAnnotations(
		useShallow(
			(state) =>
				annotationsByPage(state.annotations).get(pageNumber) ??
				emptyAnnotations,
		),
	);
}
