# Page continuity and cold loading — September 14, 2026

Baseline: merged main `5a0160f8ba95c6567b7797a147aabd04cbf68954`. This pass addresses rapid scroll/backtracking and cold document loading. It preserves final raster quality, canvas resolution limits, and existing bitmap cache budgets.

## Changes and regression evidence

| Before | After | Why |
| --- | --- | --- |
| Revisiting a cached page at another zoom hid its canvas until the new render completed. | Compatible cached pixels appear immediately and remain visible until a sharper render replaces them. | The previous cache path required an exact scale match. Preview lookup now matches the same page proxy and palette and selects the closest cached scale. |
| Background metadata acquisition began immediately after the reader mounted. | It waits for the initial canvas, with a 500 ms fallback for readers without a canvas. | First-page raster work should have priority. Explicit visible-page requests and full-document search still start immediately. |
| Changing a document source created another PDF.js worker. | The same mounted reader reuses its owned worker, destroys the old document, and releases the worker on unmount after document cleanup. | Replacing a document need not download and initialize the worker again. Caller-provided workers and global ports retain their ownership behavior. |
| Initialization failure could leave the loading message indefinitely. | An accessible error replaces it; `errorFallback` provides custom recovery UI. | Waiting and failure are different states. Both errors and published document state are scoped to the current source. |
| There was no public download-progress callback. | Optional `onDocumentProgress` reports source-tagged bytes without internal React updates for each event. | Consumers can show useful feedback without making byte events rerender the reader. Download completion is distinct from painted-page readiness. |

Browser regressions reproduced hidden cached previews, stuck failure UI, metadata work preceding first paint, and worker recreation before the fixes. Pixel checks verify both preview visibility and its replacement by newly rendered content. Additional tests cover page-proxy/background isolation, callback replacement, stale document publication, custom error UI, worker configuration changes, caller-owned workers, global worker ports, and Strict Mode cleanup.

## Production measurements

Chrome 153 on macOS ARM64, 800 × 650 viewport, DPR 1, **6× CDP CPU throttling**. Scroll and cold-open conditions contain three trials each, each in a fresh Chrome process. The source-replacement baseline was incomplete, as detailed below. Timing runs were separate from builds and tests. This host had unrelated background activity: the spread in the raw samples matters, especially for frame timings. These are controlled browser scenarios, not measurements on physical old Windows hardware.

The harness serves a production Vite bundle using the library source and the real 320-page `large.pdf` and 50-page graphics-heavy `expensive.pdf` fixtures. It includes the PDF.js runtime, worker and auxiliary assets locally.

### Rapid scrolling and revisiting

Each trial scrolls forward and back for 120 animation frames, advancing 240 logical pixels per frame to a peak of 14,160 pixels. It repeats at zoom 1.2 after pages have left the virtual range. The graphics-heavy document uses dark mode. Coverage checks actual visible base canvases, including hidden or missing canvases, rather than only counting mounted page elements.

| Median measurement | Main | Changed |
| --- | ---: | ---: |
| Graphics-heavy blank exposure at zoom 1.2 | 666.3 ms | 233.6 ms |
| Graphics-heavy frames with >1% blank page area at zoom 1.2 | 30 | 10 |
| Large-document blank exposure at zoom 1.2 | 0 ms | 0 ms |

“Blank exposure” integrates the sampled fraction of visible page height without ready canvas pixels against frame intervals. A half-empty viewport for 100 ms contributes 50 ms. This is an estimate of page continuity, not a measurement of physical screen presentation. Real-browser pixel tests separately establish that the reused preview contains the expected content.

The graphics-heavy zoom-1.2 samples were 356.6–1,482.0 ms on main and 175.3–294.2 ms after the change. Frame-time results are mixed: for example, the large-document zoom-1.2 median p95 increased from 36.7 to 60.9 ms amid substantial host variation. This pass establishes better cached-page continuity; it does **not** establish a general scrolling FPS improvement. Unseen expensive pages can still go blank while rasterizing.

### Empty-cache loading

The cold scenarios disable the browser cache and apply 80 ms latency, 750,000 download bytes/second and 250,000 upload bytes/second through CDP. Navigation-to-first-canvas includes app loading, PDF.js module import, worker initialization, document loading, metadata and first-page rasterization. The HTML shell paints earlier; it is not counted as usable PDF content.

| Median first canvas | Main | Changed |
| --- | ---: | ---: |
| Large document, page 1 | 5,666.7 ms | 5,503.4 ms |
| Large document, page 200 | 5,708.2 ms | 5,320.6 ms |
| Graphics-heavy document, page 1 | 5,057.1 ms | 5,049.6 ms |

Initial-load gains are modest; the graphics-heavy result is effectively unchanged. The final HTML first-contentful-paint samples were 152–252 ms. Some exploratory cold batches stalled while downloading the worker script, including on unchanged main; those incomplete batches are not included in these medians. The final retained cold batches completed all nine scenarios per condition. The harness reports pending resources on timeout rather than interpreting a timeout as a successful measurement.

### Replacing a document during download

Under the same cold conditions, the runner replaces `large.pdf` with the five-page `form.pdf` once the old PDF request starts. Main's completed trial took **2,526.4 ms** from source change to replacement pixels. Its second trial timed out after 60 seconds waiting for the replacement canvas; the third did not run. The final implementation completed all three trials in **407.3, 450.6 and 457.2 ms** (median 450.6 ms). This is a one-completed-baseline versus three-completed-final comparison, not a three-trial baseline median; the timeout is retained in the raw results.

Every completed trial confirms that the old in-flight download is aborted, the replacement is the correct five-page document, and no worker remains after reader unmount. The final trials also confirm that a missing PDF shows an alert and removes its loading status; main retains the loading status. Worker reuse has a clear mechanism and deterministic regression coverage, but these small timing samples do not establish a universal latency guarantee.

### Rejected experiment

Disabling streaming and auto-fetch reduced transferred PDF bytes but increased range-request round trips. In an exploratory single-trial comparison, large-page-1 readiness worsened from 4,904 to 5,395 ms and page-200 readiness from 4,993 to 5,687 ms. This is insufficient evidence to change the defaults. The library retains normal PDF.js streaming; the benchmark's `LECTOR_PAINT_RANGE=1` switch remains available to reproduce the experiment.

## Validation

The isolated change passes 283 browser tests in each of Chromium, Firefox and WebKit, 37 Node tests, library build, TypeScript, size limit, packed-package ESM/SSR checks, docs build and six agent-docs tests. Lint retains the two existing annotation-hook warnings. The isolated change adds 506 compressed bytes (58,551 → 59,057). After rebasing onto main’s subsequent text-selection change (`ca1962b`), all **308 browser tests** pass in each engine, along with the same unit, build, types, package and docs checks. The new loading examples also type-check against the built public package. The combined bundle is 59,995 compressed bytes. The measurements above isolate this pass on the earlier stated baseline; they are not fresh timings of the subsequent selection changes.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm --filter @anaralabs/lector exec vite build --config benchmarks/reader/vite.config.ts
LECTOR_PAINT_MODE=scroll LECTOR_PAINT_OUTPUT=/tmp/lector-scroll.json node packages/lector/scripts/measure-paint.mjs
LECTOR_PAINT_MODE=cold LECTOR_PAINT_OUTPUT=/tmp/lector-cold.json node packages/lector/scripts/measure-paint.mjs
LECTOR_PAINT_MODE=lifecycle LECTOR_PAINT_OUTPUT=/tmp/lector-lifecycle.json node packages/lector/scripts/measure-paint.mjs
```

Each mode defaults to three trials and 6× CPU throttling. Set `LECTOR_PAINT_TRIALS`, `LECTOR_PAINT_CPU` or `LECTOR_BROWSER_CHANNEL` to override them. For main, copy the `benchmarks/reader` directory and `scripts/measure-paint.mjs` into an isolated checkout at the baseline revision, rebuild, and run the same commands. Set `LECTOR_PAINT_BASELINE=1` for the baseline lifecycle run so it records the old missing-error-UI behavior instead of expecting the fix. Error feedback is checked after the timed source replacement, with network throttling removed; replacement timing and cancellation remain under the cold conditions.

The measurements and exploratory range experiment are retained in [the raw results](packages/lector/benchmarks/page-paint-loading-results-2026-09-14.json).
