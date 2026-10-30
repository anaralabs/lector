// Tiny PNG encoder (8-bit RGB or RGBA, no filtering) for generated fixtures.
import { deflateSync } from "node:zlib";

const table = new Int32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c;
});
const crc32 = (buf) => {
	let c = -1;
	for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
};

/** pixels: Uint8Array of w*h*channels (3 = RGB, 4 = RGBA) */
export function encodePng(pixels, w, h, channels = 3) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = channels === 4 ? 6 : 2;
	const raw = Buffer.alloc((w * channels + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * channels + 1)] = 0;
		Buffer.from(pixels.buffer, pixels.byteOffset + y * w * channels, w * channels).copy(raw, y * (w * channels + 1) + 1);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
