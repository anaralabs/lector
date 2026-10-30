# @anaralabs/lector-engine

A PDF viewer engine built for 120fps scroll and pinch:

- **PDFium (WASM)** rasterizes 512px tiles in a pool of workers. The workers read the document from one shared `Blob` (or HTTP range requests), so no `SharedArrayBuffer` or cross-origin isolation is needed.
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

Without Vite, serve `@anaralabs/lector-engine/pdfium.wasm` and the worker files yourself (the package exports `./raster-worker`, `./core-worker` and `./pdfium.wasm`), and pass their URLs as `wasmUrl` and `workerUrls`. Those three files are all you need: each worker is a single self-contained module (no shared chunks), so they can live in any directory or on a CDN.

## API reference

Pages are **0-based** everywhere. Page-space geometry is in PDF points with a top-left origin; screen geometry is in CSS px relative to the viewer container.

### `createViewer(container, source, options): Promise<Viewer>`

`source` is a URL, `ArrayBuffer` or `Uint8Array`. The promise resolves once the workers have started; the document opens asynchronously (await `viewer.loaded` or listen for `ready`). It rejects with an `EngineError` when the browser is unsupported (`code: "unsupported"`), the fetch fails (`"fetch"`), or the main-thread WebGL2 context cannot be created (`"gpu"`).

`ViewerOptions` (creation-only, plus every `CoreOptions` below):

| option | default | |
| --- | --- | --- |
| `wasmUrl` | required | URL of `pdfium.wasm` |
| `workers` | half the cores, 2–4 (2 on touch devices) | PDFium raster workers |
| `offscreen` | when supported | composite in a worker (`OffscreenCanvas`) |
| `createWorker`, `workerUrls` | | see [Workers and the wasm](#workers-and-the-wasm) |
| `onEvent(e)` | | every `CoreEvent` |
| `onLink(url)` | open in a new tab | external link clicked |
| `password` | | password for an encrypted PDF |
| `textLayer` | `true` | hidden DOM text for screen readers and native find |
| `interceptFind` | `false` | Cmd/Ctrl+F emits a `find` event instead of opening the browser's find bar |
| `rangeLoading` | `false` | load a URL with HTTP range requests (see [Large files](#large-files-and-memory)) |
| `autoFetch` | `true` | with `rangeLoading`: download the rest after the first paint |

`CoreOptions` (also live through `viewer.setOptions`; read the resolved values from `viewer.options` or the exported `defaultOptions`):

| option | default | |
| --- | --- | --- |
| `background` | `[0.93, 0.93, 0.94]` | viewport colour (0–1 rgb) |
| `pageGap` | `12` | points between pages |
| `selectionColor` / `selectionColorDark` | blue / deep blue | selection fill in light / dark mode (rgba 0–1); both live-updatable, so a host tint works in both modes |
| `highlightColor` | yellow | default highlight colour |
| `gamma` | `1.25` | glyph darkening |
| `textureBudgetMB` | `384` (128 on touch) | GPU tile budget |
| `initialZoom` | `"fit-width"` | `"fit-width"`, `"fit-page"` or a zoom factor |
| `initialPage`, `initialTop` | `0`, `0` | first page (0-based) and points below its top, applied before the first paint |
| `initialOffset` | `null` | css px from the document top at the initial zoom (lector's `initialOffset`; pair with `scrollState().top`) |
| `initialCamera` | `null` | exact restore of a saved `camera` (wins over the others) |
| `minZoom` / `maxZoom` | `0.1` / `24` | |
| `dark`, `paper`, `ink` | `false`, near-black, near-white | dark mode: page white maps to `paper`, ink to `ink` |
| `reducedMotion` | from `prefers-reduced-motion` | flights jump instantly |
| `copyOptions` | `{}` | lector's copy options: `{ lineBreaks?: "preserve" \| "space", ignoreHyphenation?: boolean }`; `false` leaves copy to the browser |

### `Viewer`

```ts
interface Viewer {
	readonly canvas: HTMLCanvasElement;
	readonly offscreen: boolean;
	readonly overlayElement: HTMLDivElement; // above canvas + text layer, pointer-events: none
	readonly loaded: Promise<{ pages: PageSize[]; info: DocumentInfo }>;
	readonly options: CoreOptions; // resolved, live
	readonly camera: Camera; // last camera: { x, y (doc points at the viewport's top-left), zoom }
	readonly selectedText: string;
	readonly isSearching: boolean;

	// camera
	zoomTo(zoom: number): void;
	fitWidth(): void;
	fitPage(): void;
	goToPage(page: number, top?: number, options?: { animate?: boolean; offset?: number }): Promise<boolean>;
	reveal(page: number, rect: Rect, options?: { animate?: boolean; align?: "auto" | "center" | "start" | number; ifNeeded?: boolean; offset?: number }): Promise<boolean>;
	scrollState(): { top: number; height: number; viewportHeight: number; fraction: number }; // css px
	scrollToFraction(fraction: number): void;

	// text
	search(query: string, limit?: number, options?: { pages?: number[]; matchDiacritics?: boolean; ignoreHyphenation?: boolean; fuzzy?: { threshold?: number }; signal?: AbortSignal }): Promise<SearchHit[]>;
	searchAsync(query: string, options?: SearchOptions & { signal?: AbortSignal; onProgress?: (partial: SearchResults) => void }): Promise<SearchResults>;
	cancelSearch(): void;
	pageText(page: number): Promise<string>;
	pageTextMap(page: number): Promise<{ text: string; chars: Int32Array }>;
	rects(page: number, from: number, to: number): Promise<Rect[]>;
	outline(): Promise<OutlineItem[]>;

	// selection
	select(page: number, from: number, to: number): void;
	setSelection(range: { start: TextPoint; end: TextPoint } | null): void;
	selectAll(scope?: "page" | "document" | "auto"): void;
	clearSelection(): void;

	// marks
	setHighlights(items: Highlight[]): void;
	pulse(ids: string | string[], options?: { kind?: "ripple" | "flash"; duration?: number }): void;

	// document
	unlock(password: string): Promise<boolean>;
	thumbnail(page: number, width: number): Promise<ImageBitmap | null>;
	getData(): Promise<Uint8Array>;
	setOptions(options: Partial<CoreOptions>): void;
	destroy(): void;
}
```

- `goToPage`/`reveal` resolve `true` when the camera lands and `false` when input or another jump interrupted it. `offset` is in css px: for `goToPage`, the gap kept above the target (default `pageGap`); for `reveal`, added to where the rect lands (e.g. under a sticky header).
- `scrollState()` reports the position as a scroll container would (`top` of `height`, at the current zoom), for persistence and custom scrollbars. Restore with `initialOffset` (same zoom) or `initialCamera` (exact).
- In fit-page mode, `goToPage`, `reveal` and link jumps fit the destination page (pages of different sizes get different zooms).
- `destroy()` stops the frame loop, terminates the workers, frees GPU resources, removes the canvas and overlay and restores the container's styles. Nothing is left pending: `loaded` (if still waiting) and every waiting request (`pageText`, `outline`, `thumbnail`, `rects`, ...) reject with an `EngineError` whose `code` is `"destroyed"` (phase `"request"`), running searches reject with an `AbortError`, `goToPage`/`reveal` resolve `false` and `unlock` resolves `false`. Requests made after `destroy()` reject right away. If the document or the engine fails to load, waiting requests reject with that load error instead.

### Search

`search()` is exact by default and returns hits in document order (limit 500). With `fuzzy`, fuzzy matches follow the exact ones, best first. `searchAsync()` mirrors lector's `useSearch().searchAsync`: `{ exactMatches, fuzzyMatches, hasMoreResults }` (plus `pagesSearched`, `pageCount`, `done`), `threshold` (default 0.7), `limit` (default 100), with lector's ranking and exact/fuzzy split.

- Pages are searched in order as their text is extracted (a few pages ahead), so the first results arrive before the whole document is loaded; `onProgress` receives partial results.
- Folding: case, ligatures (ﬁ → fi), typographic quotes and dashes, soft hyphens, whitespace; `matchDiacritics: false` folds Latin/Greek/Cyrillic accents; `ignoreHyphenation: true` joins words hyphenated at a line break. Matches cross line breaks and page breaks.
- Aborting `signal`, `cancelSearch()` or `destroy()` rejects with an `AbortError` (partial results so far arrive through `onProgress`). The listener on `signal` is removed once the search settles, however it ends.

```ts
interface SearchHit {
	page: number; index: number; length: number; // start page, char index and length there
	rects: Rect[]; // on `page`
	snippet: string; snippetMatch: [number, number]; // the match within `snippet`
	score: number; exact: boolean; // 1 / true for exact matches
	parts: { page: number; index: number; length: number; rects: Rect[] }[]; // two when the match crosses a page break
}
```

### Selection and copy

`selection` events carry `SelectionInfo { text, range: { start, end }, pages: { page, rects }[], anchor }`. `text` follows `copyOptions` (default like lector: line breaks kept, a word hyphenated at a line end copies as `-` + newline). Persist `range` and restore it with `setSelection(range)`; pages whose text was never loaded are loaded first. Cmd/Ctrl+A selects the page in view, and pressing it again selects the whole document. Keys and copy events from inputs, `contenteditable` elements and anything in `overlayElement` are left to the host.

### Events (`CoreEvent`)

| event | |
| --- | --- |
| `ready { pages, layout, info }` | the document opened: page sizes, layout in doc points, `DocumentInfo` (title, author, …, `pdfVersion`, `encrypted`, `hasForm`) |
| `painted { page }` | first bitmap on screen |
| `view { zoom, page, pageCount, fitWidth, fit }` | `fit`: `"width" \| "page" \| null`; `fitWidth` is kept for compatibility |
| `camera { camera, moving }` | every camera change; `moving: false` once it rests (persist scroll here) |
| `selection { selection, final }` | |
| `cursor`, `resized`, `link { url }`, `click { page, x, y }` | |
| `highlight-click { id, screen }`, `highlight-hover { id, screen }` | |
| `flight { id, landed, coverage, waitMs, durationMs }` | |
| `search-progress { id, results }` | partial `searchAsync` results |
| `find` | Cmd/Ctrl+F with `interceptFind` |
| `stats` | frame and memory statistics (`workerMB`: PDFium heaps + block caches) |
| `error { message, code, phase }` | see below |

### Errors

`error` events and `EngineError` (rejections of `createViewer` and `viewer.loaded`) carry a `code` and a `phase`, like lector's `onError({ error, phase, source })`:

- `code`: `password` (encrypted: pass `password` or call `viewer.unlock(password)`, which resolves `false` for a wrong one), `parse` (not a PDF or damaged), `security` (unsupported encryption), `file`, `fetch`, `unsupported` (browser), `wasm` (pdfium.wasm failed to load), `gpu` (no WebGL2 context; with phase `render`, the context was lost: drawing stops and resumes on its own if the browser restores it), `worker` (a worker script failed to load), `destroyed` (a request was still waiting when the viewer was destroyed), `unknown`.
- `phase`: `engine-load`, `document-load`, `render`, `text`, `request` (a viewer request such as `pageText`).

### Other exports

- `isEngineSupported()`, `getEngineSupport()`.
- `defaultOptions`.
- `toneMap(rgb, paper, ink, gamma?)`: the dark-mode page colour mapping. `markColor(rgba, paper?)`: the opaque fill the compositor paints for a highlight or selection colour in light mode, or in dark mode when you pass `paper`. Hosts can use these to match swatches and legends.
- Types: `Camera`, `CoreEvent`, `CoreOptions`, `DocumentInfo`, `EngineError`, `ErrorCode`, `ErrorPhase`, `Highlight`, `Link`, `OutlineItem`, `PageSize`, `Rect`, `SearchHit`, `SearchOptions`, `SearchResults`, `SelectionInfo`, `SelectionTextOptions`, `Stats`, `TextLayerLine`, `TextPoint`.

`<LectorView>` (from `/react`, a client component) takes `source`, `options` (live `CoreOptions`), `onEvent`, `onViewer`, `className`, `style` and every creation option (`wasmUrl`, `workers`, `offscreen`, `onLink`, `createWorker`, `workerUrls`, `password`, `textLayer`, `interceptFind`, `rangeLoading`, `autoFetch`). Its ref is the `Viewer`. Changing any of those except the callbacks recreates the viewer.

## Behaviour notes and trade-offs

### Dark mode and scans

Dark mode tone-maps vector content on the GPU. Raster images keep their original colours, so photos are not inverted, and highlights over them use the light style. Scanned pages are the exception. An image that papers the page (one image covering ≥70% of it, or dense strips or tiles) and samples as opaque, mostly near-white, low-saturation paper with some ink is tone-mapped like vector content. This is lector's scan-invert policy, run once per page in the raster worker.

### Accessibility and native find

The hidden text layer holds one transparent, unselectable, click-through span per text line. It covers only the visible pages ±1. Spans are sized from PDFium's character boxes and positioned under a single CSS transform that follows the camera, so scrolling never causes layout. The layer has `role="document"`, and each page is a `region` labelled "Page N". Screen readers read it, and the browser's find matches it. When find scrolls a match into view, the viewer pans the camera there.

**Trade-off:** native find only sees the pages near the viewport, and its highlight is drawn on the transparent text (the GPU selection is not involved). Hosts with their own search UI should set `interceptFind: true` and open their search (`viewer.searchAsync`) on the `find` event.

### Large files and memory

Raster workers never hold a copy of the document. Each one opens it with `FPDF_LoadCustomDocument` and reads 64KB blocks on demand from one `Blob` shared by all workers (`FileReaderSync`, LRU cache capped at 24MB per worker). Before this change, every worker had the whole file in its WASM heap. A URL is downloaded as a `Blob`, which browsers may keep on disk.

`rangeLoading: true` reads 256KB blocks with synchronous range requests from the workers, after a 1KB probe. It falls back to a full download when the server ignores `Range` or compresses the response. After the first paint, the whole file downloads in the background (`autoFetch`), and the workers switch to it. Range loading is **opt-in** for three reasons:

- The layout needs every page's size up front, and each size parses that page's dictionary. In files whose page dictionaries are spread out (no object streams), that costs about one range request per page, which is slower than a plain download: a 67MB, 1040-page file took 27s to `ready` at 50 Mbit/s, against 13s for a full download. Files with object streams or compact page trees benefit a lot: 53MB, 1040 pages, 3.3s against 11.8s.
- The server needs `Range` support without content encoding, and cross-origin servers must expose `Content-Range`.
- Requests are synchronous inside the workers, so a slow block stalls that worker.

### Forms

Documents with an AcroForm get a PDFium form fill environment in each raster worker. Fields render through `FPDF_FFLDraw`, including filled fields that have no appearance streams (`NeedAppearances`). Field highlighting is off. **Interactive editing is not supported.** Every raster worker holds its own PDFium document, so edits would have to be replayed in every worker, keys and focus routed to PDFium, the caret animated, and the affected tiles re-rendered on each keystroke. Hosts that need editing should overlay their own inputs through `overlayElement`.

### Right-to-left and vertical text

Lines are grouped by direction. A line whose first strong character is Hebrew, Arabic, Syriac, Thaana, N'Ko or a similar script is right-to-left. Its characters move left. Caret hit-testing finds the glyph under the pointer by its box (visual order), then puts the caret before or after it by that character's own direction, so Latin inside Hebrew (and the reverse) hit-tests correctly. A line whose second character sits directly below the first is vertical: CJK text written top to bottom, hit-tested by column. The text layer marks these lines with `dir="rtl"` or `writing-mode: vertical-rl`.

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
pnpm dev               # demo at http://127.0.0.1:5199 (?offscreen=0, ?dark=1, ?file=…, ?page=, ?zoom=fit-page, ?range=1, ?password=, ?interceptFind=1, ?textLayer=0)
pnpm build             # dist/ via tsup + scripts/postbuild.mjs
pnpm typecheck
pnpm test:unit         # node --test (block cache)
pnpm test:package      # pack; check exports, license notices, and boot the self-hosted workers in Chrome
node bench/features.mjs   # search / outline / selection / dark mode against the demo
node bench/compat.mjs     # emulated old browsers: compositor fallback and clean rejection
node bench/clicks.mjs     # double/triple click in Chrome, Firefox, WebKit (npx playwright-core install firefox webkit)
node bench/frames.mjs     # frame timing (HEADED=1 for a vsync'd window)
node bench/memory.mjs [/big.pdf] ["&range=1"] [Mbit/s]   # ready/painted time and memory
```

Fixtures other than `cadbots.pdf` are generated, not committed: `node bench/fixtures/make-{scan,password,form,rtl,links,big}.mjs`. They need `pdf-lib` (and `mupdf` for the password fixture). Point `PDF_LIB` / `MUPDF` at those packages. `features.mjs` skips checks whose fixture is missing.

The demo sets `globalThis.__lectorEngineDebug = true`, which exposes the core as `window.__core` (main-thread compositor) or `self.__core` (compositor worker) for the benches. Hosts should not set it.

## License

MIT (see `LICENSE`). `pdfium.wasm` is PDFium (BSD-3-Clause and Apache-2.0) built by `@embedpdf/pdfium` (MIT); their licenses ship as `dist/LICENSE.pdfium` and `dist/LICENSE.embedpdf`, and `THIRD_PARTY_NOTICES.md` holds the full license texts of the libraries compiled into the wasm (and which of them are inferred rather than confirmed).
