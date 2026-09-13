import { expect, test, vi } from "vitest";
import { mapConcurrent } from "../src/lib/map-concurrent";

test("bounds in-flight work and preserves order when pages finish out of order", async () => {
	let active = 0,
		peak = 0;
	const result = await mapConcurrent([1, 2, 3, 4], 2, async (n) => {
		peak = Math.max(peak, ++active);
		await new Promise((resolve) => setTimeout(resolve, 5 - n));
		active--;
		return n * 10;
	});
	expect(peak).toBe(2);
	expect(result).toEqual([10, 20, 30, 40]);
});

test("failure and disposal stop scheduling new pages", async () => {
	const failure = vi.fn(async () => {
		throw new Error("page failed");
	});
	await expect(mapConcurrent([1, 2, 3, 4], 2, failure)).rejects.toThrow(
		"page failed",
	);
	expect(failure).toHaveBeenCalledTimes(2);
	let cancelled = false;
	const load = vi.fn(async (n) => {
		cancelled = true;
		return n;
	});
	await expect(
		mapConcurrent([1, 2, 3], 1, load, () => cancelled),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(load).toHaveBeenCalledTimes(1);
	await expect(mapConcurrent([], 0, load)).rejects.toThrow(RangeError);
});
