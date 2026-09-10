# Lector performance review — 10 September 2026

> Historical first-pass measurements from `29f89b2`. The PR is being reconciled with current main (`675ce1b`), which already includes independent Safari/base-canvas and bitmap-budget improvements. Those overlapping changes are not carried by this PR. Current-main measurements and final scope are recorded in `PERFORMANCE-SECOND-PASS.md`.

This pass improves search, document-loading work, rendering, bitmap retention, observers, and store subscriptions. It adds reproducible browser measurements and regression tests. It does not establish an overall viewer speedup: the measurements below exercise specific paths, and the real-document coverage is one five-page PDF.

## Measured results

Search measurements run the real `useSearch` hook in headless Chrome against a deterministic 100,000-character document (20 pages). Each query gets one warmup and five measured runs. The baseline and final implementation were run separately without concurrent builds. Numbers are medians; exact-search time is near the browser timer's resolution.

| Workload | Before | After |
| --- | ---: | ---: |
| Exact-only search, `document` | 27.5 ms | ≤0.1 ms |
| Short fuzzy search, `documant` | 26.6 ms | 3.6 ms (7.4× faster) |
| Fuzzy phrase, `efficient page navigatoin` | 174.6 ms | 21.4 ms (8.2× faster) |
| Notifications from 3,000 unchanged store writes | 3,000 | 0 |
| Visibility observers for 100 thumbnail consumers | 100 | 1 |
| Display-resolution listeners for 100 consumers | 100 | 1 |
| Text-extraction calls: two search consumers, 100 pages | 200 | 100 |
| Peak simultaneous extraction requests in that fixture | 200 | 4 |
| Rerenders from 50 download-progress events | 50 | 0 |
| Extra base-canvas blits when zooming 100% → 200% → 300% | 2 | 0 |
| Width reads: 1,000 pages, 99 changed current-page writes | 99,000 | 0 |

Work-count probes were run before and after each individual fix. The width probe already included the no-op store guard, so 99 of its 100 writes changed state.

The bitmap cache now retains at most **64 MiB of estimated RGBA pixel data**, as well as at most 60 entries. Previously, 60 cached 2048×2048 bitmaps could retain **960 MiB** of pixel data. The regression test uses synthetic bitmap objects to verify retention and disposal; these are pixel-accounting figures, not measured browser RAM or GPU allocation. Visible canvases, render buffers, PDF.js data and GPU overhead are outside this limit.

The existing Size Limit check reports **40,259 → 40,774 bytes** after compression/bundling: an increase of 515 bytes (1.3%), within the existing 150 kB budget.

Raw samples, environment details and the baseline revision are in [results-2026-09-10.json](packages/lector/benchmarks/results-2026-09-10.json). The measured environment was ARM64, macOS 26.5.2, Node 22.22.3, Chrome 153 Canary and the existing lockfile. Browser/JIT behavior matters: benchmark results should be compared on the same device and browser.

## Changes and behavior

- **Search:** replace per-character quadratic matrices with reusable, threshold-banded edit-distance rows and early rejection. Skip fuzzy scanning when no nonzero distance can qualify. Cache normalized page text with weak keys, keep only the requested best matches, and avoid repeatedly copying result arrays. Exact exclusion ranges are scoped to their own page.
- **Search correctness:** exact matches on one page no longer hide fuzzy matches at the same offset on another. Unused fuzzy-result slots are filled with exact matches, so an exact-only query can return the full requested limit. Empty queries, stable ranking, offsets and snippets remain covered. The distance implementation is checked against full Levenshtein across 20,000 seeded windows.
- **Text extraction:** share one indexing job between consumers of the same page array; limit work to four requests; preserve page order; reuse completed text; cancel further scheduling when the last consumer leaves; retry failed jobs. Existing in-flight PDF.js requests finish. Strict Mode's effect replay can reattach to the same job.
- **Document loading:** remove progress state that was never exposed or consumed, write page proxies in document order without sorting, and prevent disposed documents from publishing late viewport results.
- **Rendering and memory:** avoid clearing and blitting the base canvas when zoom changes above 100%; the detail layer still handles magnification. Replace linear LRU bookkeeping and collision-prone background hashes with direct lookups and explicit bitmap disposal under a byte budget.
- **Subscriptions and geometry:** share visibility and DPR observers, follow resolution changes in both directions, clean up the final subscriber, avoid unchanged store writes, and recompute maximum page width only when viewports change.

The smaller cache can cause more PDF.js renders when revisiting evicted pages. Four-way indexing deliberately bounds background work; it is not a claim of faster total indexing. Fuzzy search remains synchronous and scans the document, so sufficiently long documents or queries can still block input. Public exports remain unchanged; the search-result corrections above are observable behavior changes.

## Reproduce and validate

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @anaralabs/lector exec tsup
pnpm --filter @anaralabs/lector test
pnpm --filter @anaralabs/lector lint
pnpm --filter @anaralabs/lector bench:performance
```

Local browser tests use installed Chrome. CI installs Playwright Chromium and uses it automatically. To run that same browser locally:

```sh
pnpm --filter @anaralabs/lector exec playwright install chromium
CI=1 pnpm --filter @anaralabs/lector test:browser
```

The suite includes 9 Node tests and 15 browser tests: algorithm equivalence, rankings, cancellation/retry, cache eviction, observer lifecycle, store fan-out, source replacement, geometry scans, and real PDF.js canvas/text rendering, zoom and canvas cleanup using `src/static/form.pdf`. Timing logs are observational; deterministic work counts and correctness assertions enforce regressions without hardware-dependent timing thresholds. The existing release workflow now runs tests and requires them before releasing. The workflow itself has not been run on GitHub in this session.

## Further opportunities, in priority order

These are findings from the remaining code, not measured improvements from this patch.

| Priority | Area and evidence | Next change and measurement |
| --- | --- | --- |
| High | Startup: `document.ts` still awaits every `getPage()` and viewport before mounting the viewer. `getPdfPageProxy()` is synchronous and assumes every page exists. | Introduce a page-resource interface, render the initial page first, estimate unknown dimensions and load nearby pages on demand. Measure first meaningful paint and memory for 10/100/1,000 pages, including mixed page sizes and deep links. This requires a coordinated API/internal-state change. |
| High | Search remains synchronous; the fixture's phrase search still takes about 21 ms. | Add a cancellable asynchronous search API backed by a worker or cooperatively scheduled chunks. Keep the existing sync API compatible. Measure input latency, obsolete-query cancellation and index transfer costs on million-character documents. |
| High | `Thumbnails` mounts one React component and placeholder per document page despite sharing observers. | Offer a virtualized thumbnail list with explicit size/scroll-container control. Measure mount time, DOM count, scroll anchoring and keyboard navigation across 1,000 pages. |
| Medium | `useAnnotations()` subscribes to the entire annotation store; page layers filter global arrays on changes. | Add an optional selector and an index by page with stable page results. Preserve highlights crossing page boundaries. Measure renders and filter work while editing one annotation among thousands. |
| Medium | Detail rendering remeasures DOM rectangles and schedules work on viewport invalidation. Its buffers are separate from the new base-bitmap budget. | Cache the rendered page/zoom/visible-rectangle tuple, centralize frame geometry reads and budget detail buffers. Profile zoomed scrolling under large consumer stylesheets; exercise render cancellation and failures. |
| Medium | `Pages` overrides virtualizer behavior and accesses private methods. | Replace the private-method patch with a supported adapter and integration coverage for restored offsets, variable page dimensions, fit-width and pinch gestures before changing the dependency version. |
| Medium | Search-result highlighting fetches page text again and assumes each item has `str`; text layers stream content independently. | Introduce bounded page text/position resources with explicit ownership. Cover marked-content items, rotated pages, multi-item matches and Unicode offsets before sharing extraction data across layers. |
| Medium | Validation currently has a small real-PDF fixture and Chrome coverage. | Add large text PDFs, scanned image PDFs, mixed rotations, encrypted/malformed PDFs, rapid source changes, Safari/iOS and Firefox. Track first paint, p95 scroll frame time, long tasks, peak retained resources and mounted DOM nodes. |
| Maintenance | Packaging exposes `esm-only.cjs` but the published `files` list contains only `dist`; declaration extraction reports a compiler-version mismatch. | Add a packed-package consumer test for ESM, the CommonJS error path, SSR and types; then align packaging and declaration tooling. Audit entry-point tree shaking before changing dependencies. |

The next substantial project should be progressive document loading plus long-document/browser fixtures. It addresses a startup bottleneck that remains outside these local hot-path optimizations.
