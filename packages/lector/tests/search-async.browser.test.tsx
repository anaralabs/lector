import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useSearch } from "../src/hooks/search/useSearch";
import { PDFStore } from "../src/internal";
import { searchDocument, searchDocumentAsync } from "../src/lib/search";
import { wrapperFor } from "./helpers";

afterEach(cleanup);
const pages = Array.from({ length: 200 }, (_, i) => ({
	pageNumber: i + 1,
	text: "The library renders documents with searchable text, annotations and efficient page navigation. "
		.repeat(54)
		.slice(0, 5000),
}));

test("async search yields to input and returns exactly the synchronous results", async () => {
	const query = "efficient page navigatoin";
	let fired = false;
	const start = performance.now();
	let syncDelay = 0;
	const syncInput = new Promise<void>((resolve) =>
		setTimeout(() => {
			syncDelay = performance.now() - start;
			resolve();
		}, 0),
	);
	const expected = searchDocument(pages, query);
	await syncInput;
	let inputDelay = 0;
	const asyncStart = performance.now();
	const asyncInput = new Promise<void>((resolve) =>
		setTimeout(() => {
			fired = true;
			inputDelay = performance.now() - asyncStart;
			resolve();
		}, 0),
	);
	let complete = false;
	const pending = searchDocumentAsync(pages, query).then((result) => {
		complete = true;
		return result;
	});
	await asyncInput;
	expect(fired).toBe(true);
	expect(complete).toBe(false);
	const result = await pending;
	expect(result).toEqual(expected);
	console.info(
		`AUDIT million-character-search: syncInputDelayMs=${syncDelay.toFixed(1)}, asyncInputDelayMs=${inputDelay.toFixed(1)}, asyncTotalMs=${(performance.now() - asyncStart).toFixed(1)}`,
	);
	// Correctness does not depend on CPU speed: verify cancellation can run
	// while there is still remaining search work.
	const controller = new AbortController();
	const aborted = searchDocumentAsync(pages, query, {
		signal: controller.signal,
		timeSliceMs: 1,
	});
	controller.abort();
	await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
});

test("superseded hook searches reject and never overwrite newer results", async () => {
	const { result } = renderHook(
		() => ({ search: useSearch(), store: PDFStore.useContext() }),
		{ wrapper: wrapperFor() },
	);
	act(() => result.current.store.getState().setTextContent(pages));
	await act(async () => {
		const old = result.current.search.searchAsync("efficient page navigatoin", {
			timeSliceMs: 1,
		});
		const caught = old.catch((error) => error);
		const latest = await result.current.search.searchAsync("document", {
			threshold: 1,
		});
		expect(latest.exactMatches.length).toBeGreaterThan(0);
		expect(await caught).toMatchObject({ name: "AbortError" });
	});
	expect(result.current.search.searchResults.exactMatches[0]?.searchText).toBe(
		"document",
	);
	expect(result.current.search.isSearching).toBe(false);
});

test("unmount cancels active work; a pre-aborted external signal rejects", async () => {
	const { result, unmount } = renderHook(
		() => ({ search: useSearch(), store: PDFStore.useContext() }),
		{ wrapper: wrapperFor() },
	);
	act(() => result.current.store.getState().setTextContent(pages));
	const controller = new AbortController();
	controller.abort();
	await act(async () => {
		await expect(
			result.current.search.searchAsync("x", { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
	});
	let pending!: Promise<unknown>;
	act(() => {
		pending = result.current.search
			.searchAsync("efficient page navigatoin", { timeSliceMs: 1 })
			.catch((error) => error);
	});
	unmount();
	expect(await pending).toMatchObject({ name: "AbortError" });
});

test("document replacement cancels old search before it can publish results", async () => {
	const { result } = renderHook(
		() => ({ search: useSearch(), store: PDFStore.useContext() }),
		{ wrapper: wrapperFor() },
	);
	act(() => result.current.store.getState().setTextContent(pages));
	let pending!: Promise<unknown>;
	act(() => {
		pending = result.current.search
			.searchAsync("efficient page navigatoin", { timeSliceMs: 1 })
			.catch((error) => error);
	});
	act(() =>
		result.current.store
			.getState()
			.setTextContent([{ pageNumber: 1, text: "Replacement document" }]),
	);
	expect(await pending).toMatchObject({ name: "AbortError" });
	expect(result.current.search.searchResults.exactMatches).toEqual([]);
	expect(result.current.search.isSearching).toBe(false);
});
