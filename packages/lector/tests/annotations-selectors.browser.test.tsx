import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
	type Annotation,
	AnnotationsStoreProvider,
	useAnnotations,
	usePageAnnotations,
} from "../src/hooks/useAnnotations";

afterEach(cleanup);
const rect = (pageNumber: number) => ({
	pageNumber,
	top: 1,
	left: 1,
	width: 10,
	height: 10,
});
const annotation = (id: string, pageNumber: number): Annotation => ({
	id,
	pageNumber,
	highlights: [rect(pageNumber)],
	color: "yellow",
	borderColor: "orange",
	createdAt: new Date(0),
	updatedAt: new Date(0),
});

test("page indexes preserve cross-page highlights, underlines, order and stable unrelated results", () => {
	const { result } = renderHook(
		() => ({
			state: useAnnotations(),
			p1: usePageAnnotations(1),
			p2: usePageAnnotations(2),
			p3: usePageAnnotations(3),
		}),
		{ wrapper: AnnotationsStoreProvider },
	);
	const first = {
		...annotation("a", 1),
		highlights: [rect(1), rect(2), rect(2)],
		underlines: [rect(3)],
	};
	const second = annotation("b", 2);
	act(() => result.current.state.setAnnotations([first, second]));
	expect(result.current.p2).toEqual([first, second]);
	expect(result.current.p3).toEqual([first]);
	const p3 = result.current.p3;
	act(() => result.current.state.updateAnnotation("b", { comment: "updated" }));
	expect(result.current.p3).toBe(p3);
	expect(result.current.p2[1]?.comment).toBe("updated");
	act(() =>
		result.current.state.updateAnnotation("a", {
			highlights: [rect(1)],
			underlines: [],
		}),
	);
	expect(result.current.p2.map((x) => x.id)).toEqual(["b"]);
	expect(result.current.p3).toEqual([]);
	act(() => result.current.state.deleteAnnotation("a"));
	expect(result.current.p1).toEqual([]);
});

test("selector consumers keep action identities across store updates", () => {
	let renders = 0;
	const { result } = renderHook(
		() => {
			renders++;
			return useAnnotations((state) => state.addAnnotation);
		},
		{ wrapper: AnnotationsStoreProvider },
	);
	const action = result.current;
	act(() => action(annotation("a", 1)));
	expect(result.current).toBe(action);
	expect(renders).toBe(1);
});

test("incremental indexes agree with filtering across edits, moves, duplicates and replacements", () => {
	const { result } = renderHook(
		() => ({
			state: useAnnotations(),
			pages: [
				usePageAnnotations(1),
				usePageAnnotations(2),
				usePageAnnotations(3),
			],
		}),
		{ wrapper: AnnotationsStoreProvider },
	);
	act(() =>
		result.current.state.setAnnotations([
			annotation("duplicate", 1),
			annotation("duplicate", 3),
		]),
	);
	for (let step = 0; step < 100; step++) {
		act(() => {
			const state = result.current.state;
			const id = step % 7 === 0 ? "duplicate" : String(step % 9);
			if (step % 4 === 0) state.addAnnotation(annotation(id, (step % 3) + 1));
			else if (step % 4 === 1)
				state.updateAnnotation(id, {
					pageNumber: 2,
					highlights: [rect(3), rect(1)],
					underlines: [rect(2)],
				});
			else if (step % 4 === 2)
				state.updateAnnotation(id, {
					comment: String(step),
					highlights: [],
					underlines: [],
				});
			else state.deleteAnnotation(id);
		});
		for (let page = 1; page <= 3; page++)
			expect(result.current.pages[page - 1]).toEqual(
				result.current.state.annotations.filter(
					(a) =>
						a.pageNumber === page ||
						[...a.highlights, ...(a.underlines ?? [])].some(
							(r) => r.pageNumber === page,
						),
				),
			);
	}
	act(() =>
		result.current.state.setAnnotations([annotation("replacement", 3)]),
	);
	expect(result.current.pages).toEqual([
		[],
		[],
		result.current.state.annotations,
	]);
});

test("unchanged updates and missing IDs do not notify annotation consumers", () => {
	let renders = 0;
	const { result } = renderHook(
		() => {
			renders++;
			return useAnnotations();
		},
		{ wrapper: AnnotationsStoreProvider },
	);
	act(() => result.current.addAnnotation(annotation("a", 1)));
	const before = renders;
	const snapshot = result.current.annotations;
	act(() => {
		result.current.updateAnnotation("a", { color: "yellow" });
		result.current.updateAnnotation("missing", { comment: "x" });
		result.current.deleteAnnotation("missing");
		result.current.setAnnotations(snapshot);
	});
	expect(renders).toBe(before);
	expect(result.current.annotations).toBe(snapshot);
});
