import { readFile } from "node:fs/promises";
import { defineConfig, type Options } from "tsup";

// Oldest browsers that have every runtime feature the engine needs (WebGL2,
// module workers, dynamic import in workers, WASM); see src/support.ts.
export const browserTarget = ["chrome80", "edge80", "firefox114", "safari15", "ios15"];

/** Source refers to sibling `.ts` worker modules; the published files are `.js`. */
const workerUrlsToJs: NonNullable<Options["esbuildPlugins"]>[number] = {
	name: "worker-urls-to-js",
	setup(build) {
		build.onLoad({ filter: /[\\/]src[\\/](viewer|renderer)\.ts$/ }, async (args) => {
			const source = await readFile(args.path, "utf8");
			const contents = source.replace(/new URL\("\.\/(raster|core)-worker\.ts", import\.meta\.url\)/g, 'new URL("./$1-worker.js", import.meta.url)');
			if (contents === source) throw new Error(`worker-urls-to-js: no worker URLs found in ${args.path}`);
			return { contents, loader: "ts" };
		});
	},
};

const shared: Options = {
	format: ["esm"],
	platform: "browser",
	target: browserTarget,
	outDir: "dist",
	// The build script empties dist/ first: the configs build in parallel.
	clean: false,
	treeshake: true,
	sourcemap: true,
};

export default defineConfig([
	{
		...shared,
		entry: { index: "src/index.ts", react: "src/react.tsx" },
		splitting: true,
		dts: { entry: { index: "src/index.ts", react: "src/react.tsx" } },
		external: ["react", "react/jsx-runtime"],
		esbuildPlugins: [workerUrlsToJs],
	},
	{
		// Feature detection on its own: dist/index.js re-exports a shared chunk
		// that holds the whole engine, so a host that only checks support (and
		// lazy-loads the viewer) imports this entry instead. No other chunks.
		...shared,
		entry: { support: "src/support.ts" },
		splitting: false,
		dts: { entry: { support: "src/support.ts" } },
	},
	{
		// Server-side text extraction: Node 20+, reads dist/pdfium.wasm from disk.
		...shared,
		entry: { node: "src/node.ts" },
		platform: "node",
		target: "node20",
		splitting: false,
		dts: { entry: { node: "src/node.ts" } },
	},
	{
		// Each worker is one self-contained file (no shared chunks), so hosts can
		// self-host the documented files: raster-worker.js, core-worker.js, pdfium.wasm.
		...shared,
		entry: { "raster-worker": "src/raster-worker.ts", "core-worker": "src/core-worker.ts" },
		splitting: false,
		// Hosts may serve these files as they are, so ship them minified. The
		// PDFium glue (src/pdfium/pdfium.js) is bundled into the raster worker;
		// scripts/postbuild.mjs puts its wasm next to it in dist/.
		minify: true,
	},
]);
