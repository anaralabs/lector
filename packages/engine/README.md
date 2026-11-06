# @anaralabs/lector-engine

A PDF viewer engine built for 120fps scroll and pinch:

- **PDFium (WASM)** rasterizes 512px tiles in a pool of workers. The workers read the document from one shared `Blob` (or HTTP range requests), so no `SharedArrayBuffer` or cross-origin isolation is needed.
- A **WebGL2 compositor** draws the tiles under one camera (scroll and pinch at the same time, no DOM per page). Where WebGL2 works on an `OffscreenCanvas`, the compositor runs in a worker, so host-page work never delays a frame. Without a usable GPU (no WebGL2, or a software rasteriser such as SwiftShader, WARP or llvmpipe) a **Canvas 2D compositor** draws the same tiles, highlights and selection instead.
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

To check support without downloading the engine, import from `/support`. It is one small file that imports nothing else, so the viewer can be loaded only when it will run:

```ts
import { isEngineSupported } from "@anaralabs/lector-engine/support";

if (isEngineSupported()) {
	const { createViewer } = await import("@anaralabs/lector-engine");
	// ...
}
```

The main entry re-exports the same functions, but importing them from there pulls in the engine's code.

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

Serve `pdfium.wasm` as `Content-Type: application/wasm`, compressed (brotli: 4.1MB raw, 1.5MB over the wire): the raster workers then compile it while it downloads (`WebAssembly.instantiateStreaming`). With another content type they wait for the whole file first. It is PDFium trimmed to the functions the engine calls, so `@embedpdf/pdfium`'s own `pdfium.wasm` (a superset) works too, only larger.

## API reference

Pages are **0-based** everywhere. Page-space geometry is in PDF points with a top-left origin; screen geometry is in CSS px relative to the viewer container.

###`createViewer(container, source, options): Promise<Viewer>`

`source` is a URL, `ArrayBuffer` or `Uint8Array`, or a promise of one (a download the host started before the viewer, e.g. when a document is clicked: the workers boot while it settles, and `LoadTimings.fetchMs` is the part of it the viewer waited for; bytes open from memory without a probe, a URL opens as usual). The workers start (and compile pdfium) while the file downloads; the promise resolves once the file (or, with `rangeLoading` and a file over 8MB, the seeds for its first page) has arrived, and the document opens asynchronously (await `viewer.loaded` or listen for `ready`). It rejects with an `EngineError` when the browser is unsupported (`code: "unsupported"`), the fetch fails (`"fetch"`), or the main-thread WebGL2 context cannot be created (`"gpu"`).

`ViewerOptions` (creation-only, plus every `CoreOptions` below):

| option | default | |
| --- | --- | --- |
| `wasmUrl` | required | URL of `pdfium.wasm` |
| `workers` | half the cores, 2–4 (2 with 4GB or less, 2 on touch devices, 1 on touch devices with 2GB or less; without a GPU 1, or 2 from 8 cores) | PDFium raster workers |
| `offscreen` | when supported | composite in a worker (`OffscreenCanvas`) |
| `createWorker`, `workerUrls` | | see [Workers and the wasm](#workers-and-the-wasm) |
| `onEvent(e)` | | every `CoreEvent` |
| `onLink(url)` | open in a new tab | external link clicked |
| `password` | | password for an encrypted PDF |
| `textLayer` | `true` | hidden DOM text for screen readers and native find |
| `interceptFind` | `false` | Cmd/Ctrl+F emits a `find` event instead of opening the browser's find bar |
| `rangeLoading` | `false` | load a URL with HTTP range requests and draw the page in view before the file has downloaded (see [Large files](#large-files-and-memory)) |
| `autoFetch` | `true` | with `rangeLoading`: download the rest after the first paint, at low priority |
| `tileCache` | `false` | keep slow pages' base bitmaps in IndexedDB so a reopened document shows them at once: `true`, or `{ key, budgetMB }` (`key` names the document, e.g. id + version; byte sources default to a content hash; budget 64MB shared by all documents, 24MB on touch, least recently used out first). Leave off for documents that must not persist on the device |

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
| `initialTarget` | `null` | where to open, applied before the first paint (wins over `initialPage`/`initialTop`/`initialOffset`): `{ page, top? }` (points below the page top), `{ page, topFraction }` (fraction of that page's height), `{ fraction }` (like `scrollToFraction`)or `{ page, rect, align?, units? }` (like `reveal`, for a citation; `units: "fraction"` for a rect in 0–1 of the page). With `rangeLoading`, that page is fetched and drawn first |
| `minZoom` / `maxZoom` | `0.1` / `24` | |
| `dark`, `paper`, `ink` | `false`, near-black, near-white | dark mode: page white maps to `paper`, ink to `ink` |
| `adaptive` | `"auto"` | Canvas 2D compositor only: `"auto"` skips look-ahead tiles while the camera moves and new sharp tiles mid-zoom, and draws and rasters at 1x while moving (full DPR ~120ms after it stops) without a GPU, or once motion frames keep missing 60Hz; `true` always moves at 1x, `false` turns it all off |
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
	annotations(page: number): Promise<PdfAnnotation[]>; // highlights, notes, ink, ... already in the file
	unlock(password: string): Promise<boolean>;
	thumbnail(page: number, width: number): Promise<ImageBitmap | null>;
	getData(): Promise<Uint8Array>; // as loaded
	saveDocument(): Promise<Uint8Array>; // with the form fields as filled in
	setOptions(options: Partial<CoreOptions>): void;
	destroy(): void;
}
```

- `goToPage`/`reveal` resolve `true` when the camera lands and `false` when input, a view command or another jump interrupted it, or the destination does not exist. They can be called at any time, even before `ready` or while the container is hidden (`display: none`, a collapsed pane, a background tab): the jump waits until the document is open and the view has a size, then lands there instantly, before the first frame at that size. Only the latest waiting jump is kept (an older one resolves `false` with cause `jump`). `offset` is in css px: for `goToPage`, the gap kept above the target (default `pageGap`); for `reveal`, added to where the rect lands (e.g. under a sticky header).
- `annotations(page)` lists the markup annotations already in the file (written by Acrobat, Preview, Zotero, ...): `kind` (`highlight`, `underline`, `squiggly`, `strikeout`, `note`, `freetext`, `ink`, shapes, `stamp`, `caret`, `file`), `rect` and `rects` (one per text-markup quad) in page points, `ink` strokes, `color`, `opacity`, `author`, `contents`, `text` (the page text under a text-markup annotation), `modified`/`created` (ISO), and `replies` (annotations whose `/IRT` points at it, oldest first). `id` is the file's `/NM`, else `obj:<object number>`. Hidden annotations, popups, links and form widgets are left out. Tiles paint their appearance, except for notes (`Text` and `Popup` annotations): their icons are hidden in the workers' copy of the document while rendering, so the host draws its own marker. The saved bytes keep the file's flags. Each page is read once, on a raster worker, at low priority.
- `scrollState()` reports the position as a scroll container would (`top` of `height`, at the current zoom), for persistence and custom scrollbars. Restore with `initialOffset` (same zoom) or `initialCamera` (exact).
- In fit-page mode, `goToPage`, `reveal` and link jumps fit the destination page (pages of different sizes get different zooms).
- `destroy()` stops the frame loop, terminates the workers, frees GPU resources, removes the canvas and overlay and restores the container's styles. Nothing is left pending: `loaded` (if still waiting) and every waiting request (`pageText`, `outline`, `thumbnail`, `rects`, ...) reject with an `EngineError` whose `code` is `"destroyed"` (phase `"request"`), running searches reject with an `AbortError`, `goToPage`/`reveal` resolve `false` and `unlock` resolves `false`. Requests made after `destroy()` reject right away. If the document or the engine fails to load, waiting requests reject with that load error instead. A worker that fails (fails to load, or throws outside a request, before or after `ready`) is terminal: an `error` event with code `worker` is emitted, then the viewer tears itself down as `destroy()` would, rejecting waiting requests with that error.

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

`selection` events carry `SelectionInfo { text, range: { start, end }, pages: { page, rects }[], anchor, unit? }`. `text` follows `copyOptions` (default like lector: line breaks kept, a word hyphenated at a line end copies as `-` + newline). Persist `range` and restore it with `setSelection(range)`; pages whose text was never loaded are loaded first. Cmd/Ctrl+A selects the page in view, and pressing it again selects the whole document. Keys and copy events from inputs, `contenteditable` elements and anything in `overlayElement` are left to the host.

Multi-click selection snaps like a text editor: a double click selects the word, a triple click the sentence, a fourth click the paragraph, and dragging after the last click extends by that unit (`unit` is `"word"`, `"sentence"` or `"paragraph"`). On touch, a long-press selects the word and the handles extend by word. Units come from the page's geometry, built on the first multi-click and cached per page: lines that share a band form visual rows; rows are cut into columns along their gutters; running headers and footers are rows in the page's outer 8% set apart by a gap; paragraphs break at larger gaps, first-line indents, short lines after a full stop and font-size changes. Words follow the Unicode rules (`Intl.Segmenter`, dictionary-based for Chinese and Japanese), with a word hyphenated across a line break kept whole. Sentences follow the Unicode rules repaired for scholarly prose: no break after abbreviations (et al., Fig., Eq., i.e., e.g., initials), decimals or before a lowercase word, a citation after a full stop stays with its sentence. A sentence or paragraph never crosses a column; a sentence cut by a page break continues onto the next page. A unit drag stays in the column it started in until the pointer is clearly inside another one, and the header/footer rows it passes over are left out of the selection. Plain click-and-drag is unchanged. OCR text layers on scans work the same way.

### Events (`CoreEvent`)

| event | |
| --- | --- |
| `ready { pages, layout, info, complete }` | the document opened: page sizes, layout in doc points, `DocumentInfo` (title, author, …, `pdfVersion`, `encrypted`, `hasForm`). `complete: false` with `rangeLoading`: some sizes are estimates |
| `layout { pages, layout, complete }` | estimated sizes resolved (range loading); the camera moved with them, so the content on screen did not |
| `painted { page }` | first bitmap on screen |
| `view { zoom, page, pageCount, fitWidth, fit }` | `fit`: `"width" \| "page" \| null`; `fitWidth` is kept for compatibility |
| `camera { camera, moving }` | every camera change; `moving: false` once it rests (persist scroll here) |
| `selection { selection, final }` | |
| `cursor`, `resized`, `link { url }`, `click { page, x, y }` | |
| `highlight-click { id, screen }`, `highlight-hover { id, screen }` | |
| `flight { id, landed, cause, coverage, waitMs, durationMs }` | a goto/reveal finished; when `landed` is false, `cause` is `"input"` (wheel, gesture, pointer down or key), `"command"` (a zoom/fit/scroll call), `"jump"` (a newer goto/reveal) or `"no-target"` (no such page, or a non-finite rect). `waitMs` includes the time a jump waited for the view to get a size |
| `search-progress { id, results }` | partial `searchAsync` results |
| `find` | Cmd/Ctrl+F with `interceptFind` |
| `form-change { name, value }` | a form field's value was committed (see [Forms](#forms)) |
| `form-widgets { page, widgets }`, `form-painted { page }` | a page's form widgets became known; a page shows its edited fields |
| `stats` | frame and memory statistics (`workerMB`: PDFium heaps + block caches; `compositor`; `rasterScale`: the lowest device pixels per CSS pixel drawn in the window, below the DPR while the 2D compositor moves at low resolution; `adaptive`: low-resolution motion is engaged) |
| `error { message, code, phase }` | see below |

### Errors

`error` events and `EngineError` (rejections of `createViewer` and `viewer.loaded`) carry a `code` and a `phase`, like lector's `onError({ error, phase, source })`:

- `code`: `password` (encrypted: pass `password` or call `viewer.unlock(password)`, which resolves `false` for a wrong one), `parse` (not a PDF or damaged), `security` (unsupported encryption), `file`, `fetch`, `unsupported` (browser), `wasm` (pdfium.wasm failed to load), `gpu` (no WebGL2 context; with phase `render`, the context was lost: drawing resumes when the browser restores it, and if it does not within 1.5s, or the context is lost a second time, the viewer moves to a CPU-backed Canvas 2D compositor on a fresh canvas and emits `compositor`; a lost 2D context is replaced the same way), `compositor` (phase `render`: the context was lost and no fresh canvas could be drawn on, even after one retry; nothing will draw, so fall back), `worker` (a worker script failed to load or crashed; the viewer tears down), `destroyed` (a request was still waiting when the viewer was destroyed), `wasm-trap` (PDFium crashed or ran out of memory and the engine gave up on the document, see below), `unknown`.
- `phase`: `engine-load`, `document-load`, `render`, `text`, `request` (a viewer request such as `pageText`).

When PDFium crashes on a page (a WebAssembly trap, abort or out-of-memory), the raster worker throws its PDFium instance away, starts a fresh one and reopens the document with its form edits. The page is tried once more; if it crashes again it is skipped: it stays blank under a `.lector-page-failed` placeholder (restyle it, or set `--lector-page-failed-color` / `--lector-page-failed-background`) and a `{ type: "page-failed", page, code: "wasm-trap" }` event fires once for it. The rest of the document keeps working. If a worker cannot start a fresh PDFium, or the document crashes PDFium more than 6 times, an `error` event with code `wasm-trap` (phase `render` or `text`) reports that the engine gave up.

### Rendering a region without a viewer

`createPageRenderer({ wasmUrl, workerUrl?, createWorker?, maxDocuments?, idleMs? })` renders part of a page to an `ImageBitmap` with no canvas, viewer or WebGL (hover previews, thumbnails, citation crops):

```ts
const renderer = createPageRenderer({ wasmUrl, workerUrl: workerUrls.raster });
const { bitmap, page, rect, scale } = await renderer.render(url, {
  page: 2,
  region: (size) => ({ x: 72, y: 100, w: size.w - 144, h: 80 }),
  width: 360 * devicePixelRatio,
  key: documentId,
  signal,
});
```

- Each open document is one raster worker reading the file as a viewer does: small files in one request, larger ones through range reads. It shares the pdfium module `preloadPdfium` compiled.
- `region` is in page points (top-left origin), or a function of the page's size; omitted, the whole page. `width` is the output width in device pixels; the height follows the region.
- At most `maxDocuments` (default 2) stay open, least recently used closed first; a document unused for `idleMs` (default 30s) closes. `key` names the document across renders (signed URLs rotate).
- `signal` stops the wait and cancels a render already running. A page outside the document rejects with a `RangeError`; load failures reject with an `EngineError`.

### Other exports

- `isEngineSupported()`, `getEngineSupport()`, also available alone from `@anaralabs/lector-engine/support`.
- `defaultOptions`.
- `toneMap(rgb, paper, ink, gamma?)`: the dark-mode page colour mapping. `markColor(rgba, paper?)`: the opaque fill the compositor paints for a highlight or selection colour in light mode, or in dark mode when you pass `paper`. Hosts can use these to match swatches and legends.
- Types: `Camera`, `CoreEvent`, `CoreOptions`, `DocumentInfo`, `EngineError`, `ErrorCode`, `ErrorPhase`, `Highlight`, `Link`, `OutlineItem`, `PageSize`, `Rect`, `SearchHit`, `SearchOptions`, `SearchResults`, `SelectionInfo`, `SelectionTextOptions`, `SelectionUnit`, `Stats`, `TextLayerLine`, `TextPoint`.

`<LectorView>` (from `/react`, a client component) takes `source`, `options` (live `CoreOptions`), `onEvent`, `onViewer`, `className`, `style` and every creation option (`wasmUrl`, `workers`, `offscreen`, `onLink`, `createWorker`, `workerUrls`, `password`, `textLayer`, `interceptFind`, `rangeLoading`, `autoFetch`, `tileCache`). Its ref is the `Viewer`. Changing any of those except the callbacks recreates the viewer.

## Server-side text (Node)

`@anaralabs/lector-engine/node` runs the same trimmed PDFium build and the same text model (`PageText`) as the viewer, without workers, canvas or GPU. A character range computed on the server selects exactly the same text in the viewer, so a citation can be stored as `{ page, start, end }` instead of text the viewer has to search for.

```ts
import { loadPdfium } from "@anaralabs/lector-engine/node";

const pdfium = await loadPdfium(); // reads dist/pdfium.wasm; pass { wasm } (bytes, module or path) when bundling
const doc = pdfium.open(new Uint8Array(await readFile("paper.pdf")));
const page = doc.pageText(0);
page.text; // === (await viewer.pageTextMap(0)).text
page.rects(start, end); // === the rects the viewer draws for that range
doc.close();
```

- `page.text` and `page.chars` are what `viewer.pageTextMap(page)` returns. Offsets into `page.text` map to PDFium chars through `chars`, as the viewer does.
- `page.model` is the viewer's `PageText` (lines, `rects`, `wordAt`, `layout()`).
- One instance runs one call at a time and holds every open document in its heap: `close()` documents you are done with. Open one instance per concurrent job.
- No OCR: a scanned page without a text layer has empty text here and in the viewer.

## Behaviour notes and trade-offs

### Dark mode and scans

Dark mode tone-maps vector content on the GPU. Raster images keep their original colours, so photos are not inverted, and highlights over them use the light style. Scanned pages are the exception. An image that papers the page (one image covering ≥70% of it, or dense strips or tiles) and samples as opaque, mostly near-white, low-saturation paper with some ink is tone-mapped like vector content. This is lector's scan-invert policy, run once per page in the raster worker.

### Accessibility and native find

The hidden text layer holds one transparent, unselectable, click-through span per text line. It covers only the visible pages ±1. Spans are sized from PDFium's character boxes and positioned under a single CSS transform that follows the camera, so scrolling never causes layout. The layer has `role="document"`, and each page is a `region` labelled "Page N". Screen readers read it, and the browser's find matches it. When find scrolls a match into view, the viewer pans the camera there.

**Trade-off:** native find only sees the pages near the viewport, and its highlight is drawn on the transparent text (the GPU selection is not involved). Hosts with their own search UI should set `interceptFind: true` and open their search (`viewer.searchAsync`) on the `find` event.

### Large files and memory

Raster workers never hold a copy of the document. Each one opens it with `FPDF_LoadCustomDocument` and reads 64KB blocks on demand from one `Blob` shared by all workers (`FileReaderSync`, LRU cache capped at 24MB per worker). Before this change, every worker had the whole file in its WASM heap. A URL is downloaded as a `Blob`, which browsers may keep on disk.

`rangeLoading: true` opens the document from HTTP range requests and draws the page in view before the rest of the file has downloaded:

- The main thread probes with `Range: bytes=0-33554431`. A file up to 32MB comes back whole in that one response, and that download keeps going. Up to 8MB it is awaited and the file opens from memory, like a plain download: for a small file, one request beats the round trips PDFium makes while opening and drawing a page. If after 300ms its rate says the rest takes longer than range reads would need to open the file (a slow link), range reads start beside it.
- From 8MB to 32MB range reads start at once and race the download: the workers open from range requests seeded with the prefix the download has delivered (up to 4MB, passed on as it arrives), the main thread waits for the download instead of requesting bytes it will bring within a round trip, and the last 1MB is read in two parallel requests (256KB, and the 768KB before it, where pdfTeX's object streams often are). If the download finishes first, the file opens from it; otherwise it becomes the background download. A download that is clearly slower than range reads at its rate so far (checked from 1.5s on) stops, so it no longer competes with them.
- Above 32MB the probe's body is read only as far as the first 64KB (or, for a linearized file opening on its first page, through that page's section `/E`) and the rest is cancelled; the last 256KB (trailer, cross-reference table, and the object streams pdfTeX writes at the end) is requested as soon as the probe's headers give the length. Both go to every worker.
- Workers read at least 256KB per synchronous range request as PDFium asks for bytes. Missing blocks next to each other go out as one request, and reads that keep moving forward fetch further ahead each time (up to 1MB). The cache keeps 16KB granules, so the objects the main thread prefetches for a deep page (16KB each) do not each cost a 256KB read. A request one worker makes is passed to the others, and a page's jobs stay on the worker that loaded it, so each byte crosses the network once.
- Only the sizes of the pages the view opens on are read up front (`initialTarget`/`initialPage` and their neighbours, plus page 1). The other pages are laid out at the nearest known size, are never rasterised as estimates, and get their real sizes in the background, pages in view first. When an estimate resolves, the camera moves with the layout so the content on screen stays still (`layout` event). `scrollToFraction` (and `initialTarget: { fraction }`) made before every size is known is re-applied as sizes arrive, until the reader moves.
- After the first paint, the whole file downloads in the background at low priority (`autoFetch`), and the workers switch to it.

The `load` event's `LoadTimings` says which way a document opened (`loadMode`: `memory`, `download`, `whole` (the probe's response read to the end), `range`, or `race`: range reads while the whole file kept downloading beside them), its size (`fileKB`), the PDF requests and KB downloaded before the first paint (`requestsBeforePaint`, `kbBeforePaint`, worker range reads included), and the time to the first PDF response headers (`ttfbMs`), next to `fetchMs`, `readyMs` and `firstPaintMs`.

It falls back to a full download when the server ignores `Range` (the 200 response is used as is) or compresses the response. A cross-origin server that does not expose `Content-Range` costs one extra `HEAD` for the length (`Content-Length` is always readable). Range loading stays **opt-in** because requests are synchronous inside the workers (a slow block stalls that worker), and because in files whose page dictionaries are spread out (no object streams) resolving every size costs about one request per page: the first paint does not wait for that, but `layout` keeps changing in the background until it is done or the full download lands.

### Forms

Documents with an AcroForm get a PDFium form fill environment in each raster worker. Fields render through `FPDF_FFLDraw`, including filled fields that have no appearance streams (`NeedAppearances`). Field highlighting is off.

Fields can be filled in:

- **Text fields**: a click or tap opens a native `<input>` (`<textarea>` for multiline fields) laid over the field, so the caret, selection, IME, autocorrect, paste and the phone keyboard are the browser's. PDFium draws no caret, so typing is not forwarded key by key. Enter (single-line), Tab, Shift+Tab or a click elsewhere commits the value. Escape drops it. Tab moves to the next text field.
- **Checkboxes, radio buttons, list boxes and push buttons**: the click goes to PDFium.
- **Combo boxes**: a native `<select>` with the field's options (the system picker on phones). Free text in editable combo boxes is not supported.

Each edit is applied by every raster worker in the same order, before any job sent after it, and leaves no field focused in PDFium. The workers' documents stay identical, so any of them can render any page. Only the tiles over the edited field (and the whole-page bitmaps) re-render; the old bitmap stays on screen until its replacement arrives. Widgets of the same field on other pages re-render too, including pages whose fields are read later. After the first edit, nothing more is written to the persistent tile cache (`tileCache`), and edited pages are not read from it.

A press that starts on a field and moves (a swipe on a phone) pans as usual. Text selection and gestures off the fields are unchanged. Read-only fields and signature fields are not interactive. Form JavaScript does not run (field formatting, calculation and validation scripts included).

The `form-change { name, value }` event reports each committed value. `viewer.saveDocument()` returns the document bytes with the edits (`FPDF_SaveAsCopy`); `getData()` still returns the bytes as loaded.

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

- `isEngineSupported()` returns `false`. `getEngineSupport()` also lists what is missing (`canvas2d`, `wasm`, `module-workers`, `message-channel`, `resize-observer`, `pointer-events`), the compositor `auto` picks (`compositor`), the WebGL `renderer` string and whether it is a software rasteriser (`softwareGL`). Both functions are synchronous and cached.
- `createViewer` (and `<LectorView>`, through `onEvent`) rejects with `lector-engine is not supported in this browser (missing: …)`.
- If a worker script fails to load, an `{ type: "error" }` event names the worker.

There is no WebGL1 path: a device without WebGL2 (a blocklisted or very old GPU, a VM without a driver) gets the Canvas 2D compositor, which also replaces WebGL2 on software rasterisers, where it is faster. Force one with `compositor: "webgl2" | "canvas2d"` (default `auto`); `viewer.compositor`, the `compositor` field of `stats` and a `data-compositor="webgl2" | "canvas2d"` attribute on the viewer's container (updated if the viewer switches mid-session) say which one runs. With `auto`, WebGL2 that passes the probe but will not start in the compositor worker also falls back to 2D (`compositor` event, reason `unavailable`).

The 2D compositor is built for CPU rasterisers: the raster workers bake gamma and the dark-mode tone into each tile (photos keep their colours) and hand over `ImageBitmap`s, each pixel on screen is blitted once (fallback scales only fill the holes of the target scale), and while the zoom moves it draws at 1x and lets the browser stretch the canvas until the zoom settles (`motionResolution: false` keeps full resolution). Mid-zoom it requests no new sharp tiles and while the camera moves no look-ahead ones, and where motion frames run late it scrolls at 1x as well (`adaptive`). Without a GPU the browser's own compositing runs on the CPU too, so it starts one raster worker (two from 8 cores). Its tiles live in RAM, so it caps `textureBudgetMB` at 256. After a context-loss swap, `viewer.canvas` stays the element that receives input (transparent, above the new one), so hit-testing against it keeps working. On a 4-core machine without a GPU, and on a slow dual-core (`bench/softgl.mjs` with `HEADED=1` under `xvfb-run`, CPUs pinned with `taskset`), it holds about 60fps for scroll, pan and pinch on text documents at DPR 1 to 2, in light and dark mode.

The worker compositor needs WebGL2 on an `OffscreenCanvas`. Safari 16.4–16.x has `transferControlToOffscreen` but no WebGL on `OffscreenCanvas`, so the engine checks for a working context instead of testing for the API, and uses the main-thread compositor there. You can force the main-thread compositor with `offscreen: false`.

## Development

```sh
pnpm dev               # demo at http://127.0.0.1:5199 (?offscreen=0, ?dark=1, ?file=…, ?page=, ?top=, ?topFraction=, ?fraction=, ?zoom=fit-page, ?range=1, ?password=, ?interceptFind=1, ?textLayer=0)
pnpm build             # dist/ via tsup + scripts/postbuild.mjs
pnpm typecheck
pnpm test:unit         # node --test (block cache, range decisions, estimated layout, selection units)
pnpm test:package      # pack; check exports, license notices, and boot the self-hosted workers in Chrome
node bench/features.mjs   # search / outline / selection / dark mode against the demo
node bench/compat.mjs     # emulated old browsers: compositor fallback and clean rejection
node bench/forms.mjs      # fill in a form: text, checkbox, radio, dropdown, list box, touch, saveDocument
node bench/clicks.mjs     # double/triple/quadruple click in Chrome, Firefox, WebKit (npx playwright-core install firefox webkit)
node bench/smart-select.mjs   # word/sentence/paragraph snapping, column-aware drags, page breaks, OCR scan (paper.pdf, scan-ocr.pdf)
node bench/frames.mjs     # frame timing (HEADED=1 for a vsync'd window)
node bench/memory.mjs [/big.pdf] ["&range=1"] [Mbit/s]   # ready/painted time and memory
node bench/serve.mjs demo/dist   # HTTP/2 + ranges + server-side throttling, for open-at.mjs
MBIT=10 RTT=40 SETTLE=1 node bench/open-at.mjs https://127.0.0.1:5300 "file=/scan-big.pdf&page=32&topFraction=0.5&range=1&track=32"   # first paint, bytes before it, view movement
node bench/load-matrix.mjs https://127.0.0.1:5300 3 full:main:range=0 range:main:range=1 -- /pdf/small.pdf -- 10/50 50/150   # first paint per build × file × Mbit/RTT (builds under /<name>/, see the header)
```

Fixtures other than `cadbots.pdf` are generated, not committed: `node bench/fixtures/make-{scan,password,form,rtl,links,big,scan-big,paper,scan-ocr}.mjs`. They need `pdf-lib` (and `mupdf` for the password fixture). Point `PDF_LIB` / `MUPDF` at those packages. `features.mjs` skips checks whose fixture is missing.

The demo sets `globalThis.__lectorEngineDebug = true`, which exposes the core as `window.__core` (main-thread compositor) or `self.__core` (compositor worker) for the benches. Hosts should not set it.

## License

MIT (see `LICENSE`). `pdfium.wasm` is PDFium (BSD-3-Clause and Apache-2.0) built by `@embedpdf/pdfium` (MIT); their licenses ship as `dist/LICENSE.pdfium` and `dist/LICENSE.embedpdf`, and `THIRD_PARTY_NOTICES.md` holds the full license texts of the libraries compiled into the wasm (and which of them are inferred rather than confirmed).
