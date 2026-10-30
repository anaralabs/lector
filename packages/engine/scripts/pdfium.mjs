// Regenerates src/pdfium/ from @embedpdf/pdfium: a smaller pdfium.wasm with only
// the PDFium functions the engine calls, and the matching Emscripten glue.
//
//   node scripts/pdfium.mjs
//
// Run it after bumping @embedpdf/pdfium or calling a PDFium function the engine
// did not use before (test/pdfium.test.ts and the generated types fail until
// then). Output is deterministic for a given input and Binaryen version.
//
// - wasm: wasm-metadce keeps the Emscripten runtime exports plus the used API
//   and drops the rest of the ~600 exported functions with the code only they
//   reach. The code it keeps is not re-optimised: wasm-opt -Oz saved another
//   0.3% brotli but made first tiles ~9% slower in Chrome (less inlining while
//   V8 still runs its baseline tier).
// - glue: EmbedPDF's glue minus the wrappers of removed exports, and without its
//   `new URL("pdfium.wasm", import.meta.url)` (the raster worker instantiates the
//   wasm itself; the literal made bundlers emit a second copy).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src/pdfium");

/** PDFium API names (`FPDF*`, `FORM_*`, `PDFiumExt_*`, `EPDF*`); everything else is Emscripten runtime. */
export const API = /^(FPDF|FORM_|PDFiumExt_|EPDF)/;

/** Every PDFium function the engine's source calls as `P.<name>`. */
export function usedApi(srcDir = join(root, "src")) {
	const used = new Set();
	for (const file of readdirSync(srcDir)) {
		if (!/\.tsx?$/.test(file)) continue;
		for (const m of readFileSync(join(srcDir, file), "utf8").matchAll(/\bP\.(\w+)/g)) if (API.test(m[1])) used.add(m[1]);
	}
	return [...used].sort();
}

/** Export names of a wasm binary, in order. */
export function wasmExports(bytes) {
	let p = 8;
	const leb = () => {
		let result = 0;
		let shift = 0;
		let byte;
		do {
			byte = bytes[p++];
			result += (byte & 0x7f) * 2 ** shift;
			shift += 7;
		} while (byte & 0x80);
		return result;
	};
	const names = [];
	while (p < bytes.length) {
		const id = bytes[p++];
		const size = leb();
		const end = p + size;
		if (id === 7) {
			for (let n = leb(); n > 0; n--) {
				const len = leb();
				names.push(new TextDecoder().decode(bytes.subarray(p, p + len)));
				p += len;
				p++; // kind
				leb(); // index
			}
		}
		p = end;
	}
	return names;
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Replaces `pattern` and fails loudly when the glue no longer has the expected shape. */
function edit(source, pattern, replace, what, min = 1) {
	let count = 0;
	const result = source.replace(pattern, (...args) => {
		count++;
		return typeof replace === "function" ? replace(...args) : replace;
	});
	if (count < min) throw new Error(`scripts/pdfium.mjs: ${what} not found in the EmbedPDF glue (${count} matches); update this script for the new @embedpdf/pdfium`);
	return result;
}

function main() {
	const pkgDir = dirname(dirname(require.resolve("@embedpdf/pdfium/pdfium.wasm")));
	const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	const binaryenDir = dirname(require.resolve("binaryen/package.json"));
	const binaryen = JSON.parse(readFileSync(join(binaryenDir, "package.json"), "utf8")).version;
	const input = readFileSync(join(pkgDir, "dist/pdfium.wasm"));
	const used = usedApi();
	const exports = wasmExports(input);
	const missing = used.filter((name) => !exports.includes(name));
	if (missing.length) throw new Error(`scripts/pdfium.mjs: @embedpdf/pdfium ${pkg.version} does not export ${missing.join(", ")}`);
	const keep = exports.filter((name) => !API.test(name) || used.includes(name));
	const keepSet = new Set(keep);

	// wasm
	const tmp = mkdtempSync(join(tmpdir(), "lector-pdfium-"));
	try {
		const graph = [{ name: "root", root: true, reaches: keep.map((name) => `export:${name}`) }, ...exports.map((name) => ({ name: `export:${name}`, export: name }))];
		writeFileSync(join(tmp, "graph.json"), JSON.stringify(graph));
		// The input needs only sign-ext and mutable-globals; enabling no more keeps
		// Binaryen from emitting newer instructions than the original.
		const features = ["--mvp-features", "--enable-sign-ext", "--enable-mutable-globals"];
		execFileSync(process.execPath, [join(binaryenDir, "bin/wasm-metadce"), join(pkgDir, "dist/pdfium.wasm"), ...features, "--graph-file", join(tmp, "graph.json"), "-o", join(out, "pdfium.wasm")], { stdio: ["ignore", "ignore", "inherit"] });
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	const wasm = readFileSync(join(out, "pdfium.wasm"));
	const outExports = wasmExports(wasm);
	if (outExports.length !== keep.length || keep.some((name) => !outExports.includes(name))) throw new Error("scripts/pdfium.mjs: output exports do not match the kept set");

	// glue
	let glue = readFileSync(join(pkgDir, "dist/index.browser.js"), "utf8");
	glue = edit(glue, /^Module\['_(\w+)'\] = createExportWrapper\('\w+', \d+\);\n/gm, (line, name) => (API.test(name) && !keepSet.has(name) ? "" : line), "export wrappers", 100);
	glue = edit(glue, /"_(\w+)",/g, (item, name) => (API.test(name) && !keepSet.has(name) ? "" : item), "unexported-symbol list", 100);
	glue = edit(glue, /^ {4}(\w+): \[\[.*\], .*\],\n/gm, (line, name) => (API.test(name) && !keepSet.has(name) ? "" : line), "cwrap table", 100);
	glue = edit(glue, "return new URL('pdfium.wasm', import.meta.url).href;", "return 'pdfium.wasm';", "wasm URL");
	glue = edit(glue, /^const DEFAULT_PDFIUM_WASM_URL = .*\n/m, "", "DEFAULT_PDFIUM_WASM_URL");
	glue = edit(glue, "export { DEFAULT_PDFIUM_WASM_URL, init };", "export { init };", "exports");
	for (const name of used) if (!new RegExp(`^ {4}${name}: \\[`, "m").test(glue)) throw new Error(`scripts/pdfium.mjs: ${name} missing from the cwrap table`);
	const header = `// Generated by scripts/pdfium.mjs from @embedpdf/pdfium ${pkg.version} (MIT, see LICENSE.embedpdf). Do not edit.\n`;
	writeFileSync(join(out, "pdfium.js"), header + glue);
	writeFileSync(
		join(out, "pdfium.d.ts"),
		`${header}import type { PdfiumModule, WrappedPdfiumModule } from "@embedpdf/pdfium";

/** The PDFium functions in pdfium.wasm. Calling another one needs \`node scripts/pdfium.mjs\`. */
export type Pdfium = Pick<WrappedPdfiumModule, ${["pdfium", ...used].map((name) => `"${name}"`).join(" | ")}>;
export declare function init(moduleOverrides: Partial<PdfiumModule>): Promise<Pdfium>;
`,
	);
	const manifest = { source: `@embedpdf/pdfium@${pkg.version}`, sourceSha256: sha256(input), binaryen, sha256: sha256(wasm), api: used };
	writeFileSync(join(out, "pdfium.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	console.info(`pdfium: ${exports.length} → ${keep.length} exports, ${input.length} → ${wasm.length} bytes`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
