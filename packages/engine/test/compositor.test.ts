// node --test test/  (Node 23.6+ strips the types)
import assert from "node:assert/strict";
import { test } from "node:test";
import { bakePixels } from "../src/bake.ts";
import { classifyCompositor } from "../src/support.ts";

test("hardware WebGL2 composites with WebGL2", () => {
	for (const r of ["ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)", "Apple M2", "Mali-G78", "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)", null]) {
		assert.deepEqual(classifyCompositor(true, r), { compositor: "webgl2", softwareGL: false }, String(r));
	}
});

test("software rasterisers and missing WebGL2 get Canvas 2D", () => {
	for (const r of [
		"ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
		"ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
		"llvmpipe (LLVM 15.0.7, 256 bits)",
		"Google SwiftShader",
	]) {
		assert.deepEqual(classifyCompositor(true, r), { compositor: "canvas2d", softwareGL: true }, r);
	}
	assert.deepEqual(classifyCompositor(false, null), { compositor: "canvas2d", softwareGL: false });
});

const shaderDark = (c: number[], paper: number[], ink: number[]) => {
	const l = 0.299 * c[0]! + 0.587 * c[1]! + 0.114 * c[2]!;
	return c.map((v, i) => paper[i]! + (ink[i]! - paper[i]!) * (1 - l) + (v - l) * 0.8);
};

test("baked dark tone matches the shader's curve", () => {
	const paper = [0.12, 0.12, 0.13];
	const ink = [0.88, 0.88, 0.86];
	const colours = [[255, 255, 255], [0, 0, 0], [200, 30, 40], [12, 140, 230]];
	const px = new Uint8ClampedArray(colours.flatMap((c) => [...c, 255]));
	bakePixels(px, 4, 1, 1, [...paper, ...ink]);
	colours.forEach((c, i) => {
		const want = shaderDark(c.map((v) => v / 255), paper, ink).map((v) => Math.max(0, Math.min(255, v * 255)));
		for (let k = 0; k < 3; k++) assert.ok(Math.abs(px[i * 4 + k]! - want[k]!) <= 1, `${c} ch${k}: ${px[i * 4 + k]} vs ${want[k]}`);
	});
});

test("gamma darkens mid-tones and keeps black and white", () => {
	const px = new Uint8ClampedArray([0, 128, 255, 255]);
	bakePixels(px, 1, 1, 1.25, null);
	assert.deepEqual([...px], [0, Math.round((128 / 255) ** 1.25 * 255), 255, 255]);
});

test("photo boxes keep their colours in dark mode", () => {
	const w = 6;
	const px = new Uint8ClampedArray(w * 2 * 4).fill(255);
	bakePixels(px, w, 2, 1, [0.1, 0.1, 0.1, 0.9, 0.9, 0.9], [2, 0, 4, 1]);
	const at = (x: number, y: number) => px[(y * w + x) * 4]!;
	assert.equal(at(2, 0), 255);
	assert.equal(at(3, 0), 255);
	assert.ok(at(1, 0) < 60 && at(4, 0) < 60 && at(2, 1) < 60);
});

test("photo boxes with fractional edges finish (a box edge inside a pixel used to loop forever)", () => {
	const w = 8;
	const px = new Uint8ClampedArray(w * 3 * 4).fill(255);
	bakePixels(px, w, 3, 1, [0.1, 0.1, 0.1, 0.9, 0.9, 0.9], [2.4, 0.5, 4.6, 1.2, -3, 2.7, 1.1, 9, 7.5, -1, 20, 0.3]);
	const at = (x: number, y: number) => px[(y * w + x) * 4]!;
	assert.equal(at(3, 0), 255);
	assert.equal(at(4, 1), 255);
	assert.ok(at(6, 1) < 60);
	assert.equal(at(0, 2), 255);
	assert.equal(at(1, 2), 255);
	assert.ok(at(3, 2) < 60);
});
