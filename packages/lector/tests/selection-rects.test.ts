import { describe, expect, it } from "vitest";
import { connected, mergeTextRuns } from "../src/lib/selection-rects";

type Rect = { left: number; top: number; width: number; height: number };

/** The all-pairs merge this module used before the bounding-box prefilter.
 * It is the oracle: the prefilter may only skip groups that cannot match. */
const mergeAllPairs = <T extends Rect>(rects: T[]): T[] => {
	const groups: T[][] = [];
	for (const rect of rects) {
		const group = [rect];
		for (let i = groups.length - 1; i >= 0; i--) {
			if (groups[i]!.some((member) => connected(member, rect))) {
				group.push(...groups[i]!);
				groups.splice(i, 1);
			}
		}
		groups.push(group);
	}
	return groups.map((group) => {
		const left = Math.min(...group.map((rect) => rect.left));
		const top = Math.min(...group.map((rect) => rect.top));
		return {
			...group[0]!,
			left,
			top,
			width: Math.max(...group.map((rect) => rect.left + rect.width)) - left,
			height: Math.max(...group.map((rect) => rect.top + rect.height)) - top,
		};
	});
};

// Deterministic; a seeded generator keeps a failing case reproducible.
const random = (seed: number) => {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
};

const wordRuns = (next: () => number, count: number): Rect[] => {
	const rects: Rect[] = [];
	let left = 40;
	let top = 60;
	for (let i = 0; i < count; i++) {
		const height = 8 + Math.round(next() * 4);
		const width = 10 + Math.round(next() * 40);
		rects.push({ left, top, width, height });
		// Mostly word gaps, sometimes a line break, rarely a column jump.
		const roll = next();
		if (roll > 0.94) {
			left = 40;
			top += height + 4;
		} else if (roll > 0.9) {
			left += width + 60;
		} else {
			left += width + next() * height * 0.6;
		}
		if (top > 1400) top = 60;
	}
	return rects;
};

const scattered = (next: () => number, count: number): Rect[] =>
	Array.from({ length: count }, () => ({
		left: Math.round(next() * 600),
		top: Math.round(next() * 800),
		width: 1 + Math.round(next() * 50),
		height: 1 + Math.round(next() * 20),
	}));

describe("mergeTextRuns", () => {
	it("matches the all-pairs merge on OCR-shaped pages", () => {
		for (let seed = 1; seed <= 200; seed++) {
			const next = random(seed);
			const rects = wordRuns(next, 1 + Math.floor(next() * 120));
			expect(mergeTextRuns(rects), `seed ${seed}`).toEqual(
				mergeAllPairs(rects),
			);
		}
	});

	it("matches the all-pairs merge on scattered rects", () => {
		for (let seed = 1; seed <= 200; seed++) {
			const next = random(seed * 7919);
			const rects = scattered(next, 1 + Math.floor(next() * 80));
			expect(mergeTextRuns(rects), `seed ${seed}`).toEqual(
				mergeAllPairs(rects),
			);
		}
	});

	it("keeps member order, so the first rect's extra fields survive", () => {
		const next = random(4242);
		const rects = wordRuns(next, 400).map((rect, index) => ({
			...rect,
			pageNumber: 1,
			index,
		}));
		const merged = mergeTextRuns(rects);
		expect(merged).toEqual(mergeAllPairs(rects));
		expect(merged.map((rect) => rect.index)).toEqual(
			mergeAllPairs(rects).map((rect) => rect.index),
		);
	});

	it("agrees on a full dense page of word rects", () => {
		const rects = wordRuns(random(1234), 4000);
		expect(mergeTextRuns(rects)).toEqual(mergeAllPairs(rects));
	});

	it("leaves a single rect and an empty list alone", () => {
		expect(mergeTextRuns([])).toEqual([]);
		const one = [{ left: 1, top: 2, width: 3, height: 4 }];
		expect(mergeTextRuns(one)).toEqual(one);
	});
});
