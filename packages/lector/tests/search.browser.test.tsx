import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useSearch } from "../src/hooks/search/useSearch";
import { PDFStore } from "../src/internal";
import { wrapperFor } from "./helpers";

afterEach(cleanup);
function setup(pages: string[]) {
	const { result } = renderHook(
		() => ({ hook: useSearch(), store: PDFStore.useContext() }),
		{ wrapper: wrapperFor() },
	);
	act(() =>
		result.current.store
			.getState()
			.setTextContent(pages.map((text, i) => ({ pageNumber: i + 1, text }))),
	);
	return (query: string, options = {}) => {
		let matches!: ReturnType<typeof result.current.hook.search>;
		act(() => {
			matches = result.current.hook.search(query, options);
		});
		return matches;
	};
}

test("an exact match on one page does not suppress fuzzy matches on another", () => {
	const search = setup(["document", "documant"]);
	expect(search("document").fuzzyMatches).toEqual([
		expect.objectContaining({ pageNumber: 2, matchIndex: 0, score: 0.875 }),
	]);
});

test("fills the limit when only exact matches exist", () => {
	const search = setup(["cat ".repeat(12)]);
	const matches = search("cat", { threshold: 1, limit: 10 });
	expect(matches.exactMatches).toHaveLength(10);
	expect(matches.hasMoreResults).toBe(true);
});

test("keeps case-insensitive offsets, snippets, empty queries and stable page ordering", () => {
	const search = setup(["CAT cat", "cat"]);
	const matches = search("cat", { threshold: 1, limit: 10, textSize: 1 });
	expect(
		matches.exactMatches.map((x) => [x.pageNumber, x.matchIndex, x.text]),
	).toEqual([
		[1, 0, "CAT "],
		[1, 4, "cat"],
		[2, 0, "cat"],
	]);
	expect(matches.hasMoreResults).toBe(false);
	expect(search("  ")).toEqual({
		exactMatches: [],
		fuzzyMatches: [],
		hasMoreResults: false,
	});
});

test("unchanged state writes do not notify subscribers, changed writes still do", () => {
	const { result } = renderHook(() => PDFStore.useContext(), {
		wrapper: wrapperFor(),
	});
	let count = 0;
	const unsubscribe = result.current.subscribe(() => count++);
	const state = result.current.getState();
	state.updateZoom(1);
	state.setCurrentPage(1);
	state.setIsPinching(false);
	expect(count).toBe(0);
	state.updateZoom((x) => x + 1);
	state.setCurrentPage(2);
	state.setIsPinching(true);
	expect(count).toBe(3);
	expect(result.current.getState().zoom).toBe(2);
	unsubscribe();
});
