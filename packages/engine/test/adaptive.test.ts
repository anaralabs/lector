import assert from "node:assert/strict";
import { test } from "node:test";
import { LATE_FRAME_MS, MotionPolicy, motionScale } from "../src/adaptive.ts";

test("low-resolution motion engages after repeated late motion frames, and stays", () => {
	const p = new MotionPolicy("auto");
	for (let i = 0; i < 5; i++) p.observe(LATE_FRAME_MS + 10);
	assert.equal(p.low, false);
	p.observe(LATE_FRAME_MS + 10);
	assert.equal(p.low, true);
	for (let i = 0; i < 100; i++) p.observe(16.7);
	assert.equal(p.low, true);
});

test("occasional late frames spread over the window do not engage it", () => {
	const p = new MotionPolicy("auto");
	for (let i = 0; i < 300; i++) p.observe(i % 6 === 0 ? 40 : 16.7);
	assert.equal(p.low, false);
});

test("adaptive true, or auto without a GPU, starts engaged; false never engages", () => {
	assert.equal(new MotionPolicy(true).low, true);
	assert.equal(new MotionPolicy("auto", true).low, true);
	assert.equal(new MotionPolicy(false, true).low, false);
	const off = new MotionPolicy(false);
	for (let i = 0; i < 50; i++) off.observe(100);
	assert.equal(off.low, false);
});

test("motion scale is 1x while moving at low resolution, the DPR otherwise", () => {
	assert.equal(motionScale(2, true, true), 1);
	assert.equal(motionScale(1.5, true, false), 1.5);
	assert.equal(motionScale(2, false, true), 2);
	assert.equal(motionScale(1, true, true), 1);
	assert.equal(motionScale(0.75, true, true), 0.75);
});
