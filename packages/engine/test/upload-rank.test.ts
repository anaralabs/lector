import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadRank } from "../src/upload-rank.ts";

const frame = 7;
const tile = (page: number, scale: number, lastWanted = frame) => ({ page, scale, lastWanted });

test("visible base bitmaps first, then planned sharp tiles, then look-ahead", () => {
	assert.equal(uploadRank(tile(2, 0.5), [2, 3], frame, 0.5, 2), 0);
	assert.equal(uploadRank(tile(2, 2), [2, 3], frame, 0.5, 2), 1);
	assert.equal(uploadRank(tile(9, 2), [2, 3], frame, 0.5, 2), 2);
	assert.equal(uploadRank(tile(2, 1), [2, 3], frame, 0.5, 2), 2);
});

test("unplanned fallbacks never compete with tiles in view", () => {
	assert.equal(uploadRank(tile(2, 2, frame - 1), [2], frame, 0.5, 2), 3);
	assert.equal(uploadRank(tile(2, 0.5, frame - 1), [2], frame, 0.5, 2), 3);
	const order = [tile(2, 2, frame - 1), tile(9, 2), tile(2, 2), tile(2, 0.5)].sort((a, b) => uploadRank(a, [2], frame, 0.5, 2) - uploadRank(b, [2], frame, 0.5, 2));
	assert.deepEqual(order.map((t) => [t.page, t.scale, t.lastWanted]), [[2, 0.5, frame], [2, 2, frame], [9, 2, frame], [2, 2, frame - 1]]);
});
