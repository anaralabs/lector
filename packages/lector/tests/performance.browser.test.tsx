import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useSearch } from "../src/hooks/search/useSearch";
import { PDFStore } from "../src/internal";
import { wrapperFor } from "./helpers";

afterEach(cleanup);

test("measure search on a deterministic 100,000-character document", () => {
	const { result } = renderHook(
		() => ({ search: useSearch(), store: PDFStore.useContext() }),
		{ wrapper: wrapperFor() },
	);
	const sentence =
		"The library renders documents with searchable text, annotations and efficient page navigation. ";
	act(() =>
		result.current.store.getState().setTextContent(
			Array.from({ length: 20 }, (_, i) => ({
				pageNumber: i + 1,
				text: sentence.repeat(54).slice(0, 5000),
			})),
		),
	);
	for (const [name, query, threshold] of [
		["exact-only", "document", 1],
		["fuzzy-short", "documant", 0.7],
		["fuzzy-phrase", "efficient page navigatoin", 0.7],
	] as const) {
		const samples: number[] = [];
		for (let i = 0; i < 6; i++) {
			act(() => {
				const start = performance.now();
				const matches = result.current.search.search(query, { threshold });
				if (i > 0) samples.push(performance.now() - start);
				expect(
					matches.exactMatches.length + matches.fuzzyMatches.length,
				).toBeGreaterThan(0);
			});
		}
		samples.sort((a, b) => a - b);
		console.info(
			`PERF ${name}: median=${samples[2]!.toFixed(2)}ms samples=${samples.map((x) => x.toFixed(2)).join(",")}`,
		);
	}
});

test("measure redundant store notifications", () => {
	const { result } = renderHook(() => PDFStore.useContext(), {
		wrapper: wrapperFor(),
	});
	let notifications = 0;
	const unsubscribe = result.current.subscribe(() => notifications++);
	const state = result.current.getState();
	const start = performance.now();
	for (let i = 0; i < 1000; i++) {
		state.updateZoom(1);
		state.setCurrentPage(1);
		state.setIsPinching(false);
	}
	console.info(
		`PERF redundant-store: notifications=${notifications}, duration=${(performance.now() - start).toFixed(2)}ms`,
	);
	unsubscribe();
});
