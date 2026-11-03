import assert from "node:assert/strict";
import { test } from "node:test";
import { anchoredY, buildLayout, estimateSizes, pageAt } from "../src/layout.ts";

const letter = { w: 612, h: 792 };
const a4 = { w: 595, h: 842 };
const landscape = { w: 792, h: 612 };

test("unknown sizes take the nearest known page before them (or the first known)", () => {
	const known = [null, null, a4, null, landscape, null];
	const { sizes, estimated } = estimateSizes(known);
	assert.deepEqual(sizes, [a4, a4, a4, a4, landscape, landscape]);
	assert.deepEqual(estimated, [true, true, false, true, false, true]);
	assert.deepEqual(estimateSizes([null, null]).sizes, [letter, letter]);
});

test("the page in view stays put when earlier estimated pages resolve", () => {
	const n = 60;
	const known: ({ w: number; h: number } | null)[] = new Array(n).fill(null);
	known[0] = letter;
	known[32] = letter;
	known[33] = letter;
	const before = buildLayout(estimateSizes(known).sizes, 12).rects;
	const viewH = 700;
	// Viewport top half-way down page 32.
	const camY = before[32]!.y + letter.h / 2;
	const shotBefore = { page: pageAt(before, camY + viewH / 2), within: camY + viewH / 2 - before[pageAt(before, camY + viewH / 2)]!.y };
	// Pages 1..31 turn out to be A4 and landscape: everything above moves.
	for (let i = 1; i < 32; i++) known[i] = i % 2 ? a4 : landscape;
	const after = buildLayout(estimateSizes(known).sizes, 12).rects;
	assert.notEqual(after[32]!.y, before[32]!.y);
	const y = anchoredY(before, after, camY, viewH);
	const p = pageAt(after, y + viewH / 2);
	assert.equal(p, shotBefore.page);
	assert.ok(Math.abs(y + viewH / 2 - after[p]!.y - shotBefore.within) < 1e-9);
	// So the viewport top is at the same point of page 32 as before.
	assert.ok(Math.abs(y - after[32]!.y - (camY - before[32]!.y)) < 1e-9);
});

test("a page that resolves to another height keeps the same fraction of it at the centre", () => {
	const before = buildLayout([letter, letter, letter], 10).rects;
	const after = buildLayout([letter, { w: 612, h: 1584 }, letter], 10).rects;
	const viewH = 400;
	// Centre at 25% of page 1.
	const camY = before[1]!.y + 0.25 * letter.h - viewH / 2;
	const y = anchoredY(before, after, camY, viewH);
	assert.ok(Math.abs(y + viewH / 2 - (after[1]!.y + 0.25 * 1584)) < 1e-9);
});

test("a centre in the gap below a page keeps its distance from that page", () => {
	const before = buildLayout([letter, letter], 20).rects;
	const after = buildLayout([a4, letter], 20).rects;
	const viewH = 100;
	const camY = before[0]!.y + letter.h + 5 - viewH / 2;
	const y = anchoredY(before, after, camY, viewH);
	assert.ok(Math.abs(y + viewH / 2 - (after[0]!.y + a4.h + 5)) < 1e-9);
});

test("pageAt finds the last page starting at or above y", () => {
	const { rects } = buildLayout([letter, letter, letter], 10);
	assert.equal(pageAt(rects, 0), 0);
	assert.equal(pageAt(rects, rects[1]!.y), 1);
	assert.equal(pageAt(rects, rects[2]!.y - 1), 1);
	assert.equal(pageAt(rects, 1e9), 2);
});
