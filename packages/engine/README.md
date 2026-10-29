# @anaralabs/lector-engine

A PDF viewer engine built for 120fps scroll and pinch:

- **PDFium (WASM)** rasterizes 512px tiles in a pool of workers. Each worker holds its own copy of the document, so no `SharedArrayBuffer` or cross-origin isolation is needed.
- A **WebGL2 compositor** draws the tiles under one camera (scroll and pinch at the same time, no DOM per page). Where WebGL2 works on an `OffscreenCanvas`, the compositor runs in a worker, so host-page work never delays a frame.
- **Selection, search, links, outline and highlights** come from PDFium's character boxes and are drawn on the GPU.

The framework-agnostic core is `createViewer`; `@anaralabs/lector-engine/react` wraps it as `<LectorView>`. For a DOM/pdf.js-based headless viewer, use [`@anaralabs/lector`](../lector).

## Install

```sh
pnpm add @anaralabs/lector-engine
```

The package is ESM-only and expects a bundler. React (>=18) is an optional peer dependency, needed only for `/react`.

## Usage (Vite)

```ts
import { createViewer, isEngineSupported } from "@anaralabs/lector-engine";
import wasmUrl, { workerUrls } from "@anaralabs/lector-engine/vite-wasm";

if (isEngineSupported()) {
	const viewer = await createViewer(document.getElementById("viewer")!, "/paper.pdf", {
		wasmUrl,
		workerUrls,
		onEvent: (e) => e.type === "error" && console.error(e.message),
	});
	viewer.search("automaton").then((hits) => viewer.reveal(hits[0].page, hits[0].rects[0]));
} else {
	// fall back to another viewer, e.g. @anaralabs/lector
}
```

React:

```tsx
import { LectorView } from "@anaralabs/lector-engine/react";
import wasmUrl, { workerUrls } from "@anaralabs/lector-engine/vite-wasm";

<LectorView source="/paper.pdf" wasmUrl={wasmUrl} workerUrls={workerUrls} options={{ dark }} style={{ height: "100%" }} />;
```

### Vite config

```ts
export default defineConfig({
	worker: { format: "es" },
	// Required: the dependency optimizer cannot pre-bundle the `?worker&url` and
	// `?url` imports in `@anaralabs/lector-engine/vite-wasm`.
	optimizeDeps: { exclude: ["@anaralabs/lector-engine"] },
	// If a module that imports the engine is ever rendered on the server:
	// ssr: { noExternal: ["@anaralabs/lector-engine"] },
});
```

`@anaralabs/lector-engine/vite-wasm` is Vite-only. It resolves to:

- `default`: the URL of `pdfium.wasm`, emitted as a same-origin asset.
- `workerUrls`: `{ raster, core }`, the URLs of the two worker scripts, bundled by Vite.

### Workers and the wasm

The engine starts two kinds of module workers: `raster-worker` (PDFium) and `core-worker` (the compositor, only when `OffscreenCanvas` + WebGL2 is available). Each worker posts `{ t: "boot" }` when its module has loaded, and the engine waits for that before sending it anything.

- With no `workerUrls`, the engine calls `new Worker(new URL("./raster-worker.js", import.meta.url), { type: "module" })`, which Vite, webpack 5 and other bundlers recognise.
- With `workerUrls`, the engine starts workers from those URLs.
- With `workerUrls` and `createWorker(url, name)`, the host starts each worker. For example, a classic blob worker that runs `import(url)` survives browser extensions that re-wrap module workers and works when assets come from a CDN on another origin:

```ts
const createWorker = (url: URL, name: string) =>
	new Worker(URL.createObjectURL(new Blob([`import(${JSON.stringify(url.href)})`], { type: "text/javascript" })), { name });
```

Without Vite, serve `@anaralabs/lector-engine/pdfium.wasm` and the worker files yourself (the package exports `./raster-worker`, `./core-worker` and `./pdfium.wasm`), and pass their URLs as `wasmUrl` and `workerUrls`.

## Browser support

| Browser | Minimum | Compositor |
| --- | --- | --- |
| Chrome / Edge | 80 | worker (OffscreenCanvas) from 80 on desktop and Android |
| Firefox | 114 | worker (OffscreenCanvas) |
| Safari (macOS) | 15 | main thread on 15–16.x; worker from 17 |
| iOS / iPadOS Safari | 15 | main thread on 15–16.x; worker from 17 |

The minimums are set by **module workers** (Firefox 114, Safari 15) and dynamic `import()` in workers (Chrome 80). WebGL2, WebAssembly, pointer events and `ResizeObserver` are all older than that. The build targets those same browsers (`chrome80, firefox114, safari15`), so newer syntax is down-levelled and does not set the minimum.

Below the minimum, nothing is half-rendered:

- `isEngineSupported()` returns `false`. `getEngineSupport()` also lists what is missing (`webgl2`, `wasm`, `module-workers`, `message-channel`, `resize-observer`, `pointer-events`). Both functions are synchronous and cached.
- `createViewer` (and `<LectorView>`, through `onEvent`) rejects with `lector-engine is not supported in this browser (missing: …)`.
- If a worker script fails to load, an `{ type: "error" }` event names the worker.

There is no WebGL1 fallback, because the shaders are GLSL ES 3.00 and tiles use immutable `texStorage2D` textures. Every browser that has module workers also has WebGL2. A device without it (for example, a blocklisted GPU) should use the host's fallback viewer.

The worker compositor needs WebGL2 on an `OffscreenCanvas`. Safari 16.4–16.x has `transferControlToOffscreen` but no WebGL on `OffscreenCanvas`, so the engine checks for a working context instead of testing for the API, and uses the main-thread compositor there. You can force the main-thread compositor with `offscreen: false`.

## Development

```sh
pnpm dev               # demo at http://127.0.0.1:5199 (?offscreen=0, ?dark=1, ?file=…)
pnpm build             # dist/ via tsup + scripts/postbuild.mjs
pnpm typecheck
pnpm test:package      # pack, then check every export resolves to a file
node bench/features.mjs   # search / outline / selection / dark mode against the demo
node bench/compat.mjs     # emulated old browsers: compositor fallback and clean rejection
node bench/frames.mjs     # frame timing
```
