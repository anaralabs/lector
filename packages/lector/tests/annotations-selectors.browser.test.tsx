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
