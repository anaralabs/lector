import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_REGION_SIDE, regionRaster } from "../src/region.ts";

const letter = { w: 612, h: 792 };

test("region: the whole page when omitted, at the asked width", () => {
	const r = regionRaster(letter, undefined, 306)!;
	assert.deepEqual(r.rect, { x: 0, y: 0, w: 612, h: 792 });
	assert.equal(r.scale, 0.5);
	assert.deepEqual([r.x, r.y, r.w, r.h], [0, 0, 306, 396]);
});

test("region: a crop renders at width / region width, offset in device pixels", () => {
	const r = regionRaster(letter, { x: 72, y: 100, w: 240, h: 60 }, 720)!;
	assert.equal(r.scale, 3);
	assert.deepEqual([r.x, r.y, r.w, r.h], [216, 300, 720, 180]);
});

test("region: clamped to the page", () => {
	const r = regionRaster(letter, { x: -20, y: 780, w: 100, h: 40 }, 80)!;
	assert.deepEqual(r.rect, { x: 0, y: 780, w: 80, h: 12 });
	assert.equal(r.w, 80);
});

test("region: empty regions and widths render nothing", () => {
	assert.equal(regionRaster(letter, { x: 700, y: 0, w: 10, h: 10 }, 100), null);
	assert.equal(regionRaster(letter, { x: 0, y: 0, w: 10, h: 0 }, 100), null);
	assert.equal(regionRaster(letter, undefined, 0), null);
});

test("region: a tall region is capped on its longest side", () => {
	const r = regionRaster({ w: 100, h: 10000 }, undefined, 2000)!;
	assert.ok(r.h <= MAX_REGION_SIDE && r.w <= MAX_REGION_SIDE);
	assert.ok(Math.abs(r.w / r.h - 0.01) < 0.001);
});
