# Lector: measured performance and compatibility improvements

Base: `675ce1b`, current main when this audit started, 10 September 2026.
The original checkout was older (`29f89b2`). This PR preserves upstream's adaptive
bitmap budgets, zoom-dependent base rendering, DPR cap of 3, Safari fallbacks,
native dark mode, and recent selection fixes.

## Results against current main

These measurements support specific improvements, not a universal viewer speedup.
Search timings are medians of five runs after one warmup. Other hot-path timings
below are single observations; deterministic work counts provide the regression
checks. Baseline and candidate ran separately on the same ARM64 Mac, macOS 26.5.2,
Node 22.22.3 and Chrome 153 Canary, with the same lockfile and PDF.js 5.5.207.

| Workload | Main | PR |
| --- | ---: | ---: |
| Exact-only search, 100,000 characters | 26.4 ms | ≤0.1 ms |
| Short fuzzy search, 100,000 characters | 25.2 ms | 3.8 ms |
| Fuzzy phrase, 100,000 characters | 175.3 ms | 27.2 ms |
| Edit an offscreen annotation among 10,000; 20 visible page layers | 24.8 ms / 200 tooltip renders | 1.1 ms / 0 tooltip renders |
| Mount 1,000 thumbnails | 23.2 ms / 1,005 DOM nodes | 3.2 ms / 17 DOM nodes, with virtualization enabled |
| Find the first highlight in a dense page with 10,000 text runs | 73.4 ms | 6.6 ms |
| Peak concurrent page requests, 1,000-page PDF | 1,000 | 16 |
| Unchanged store writes, 3,000 calls | 3,000 notifications | 0 |
| Built package size, Size Limit compressed/bundled measurement | 47,850 bytes | 49,669 bytes |

The package grows by 1,819 bytes (3.8%), within the existing 150 kB budget.
The dense highlight PDF is a stress fixture: text runs wrap over the same 50 line
positions so all 10,000 runs remain inside the page. It is not representative of
a normal page. A separate synthetic stream verifies early termination after one
chunk instead of draining 1,000 chunks; real PDF.js tests verify that independent
text extraction still completes afterwards.

On a million-character query, the improved synchronous search delayed a queued
input probe by **159.5 ms**. The new `searchAsync` reduced that delay to **8.1 ms**,
with **273.0 ms** total completion time. This comparison is between the PR's sync
and async APIs. Cooperative scheduling improves responsiveness at a throughput
cost; it does not make the whole search complete faster. The 8 ms budget is
approximate, not a hard bound for unusually long individual operations.

Raw samples and methodology: [current-main-results-2026-09-10.json](packages/lector/benchmarks/current-main-results-2026-09-10.json).
The earlier JSON belongs to the historical checkout and is not the baseline for
this table.

## Real-document coverage

The corpus uses four checked-in PDFs, each in light and dark mode, with three
runs per combination. It renders the first page, scrolls across the document in
45 animation frames, waits for the last page, then checks canvas cleanup on
unmount. First-canvas-ready time is captured directly from the rendering store;
it excludes test polling delay but is not an optical screen-paint measurement.

| PDF / mode | Pages | First canvas ready, main → PR | Median run's scroll-frame p95, main → PR |
| --- | ---: | ---: | ---: |
| Brochure / light | 12 | 145.2 → 131.2 ms | 17.5 → 17.4 ms |
| Brochure / dark | 12 | 131.6 → 132.0 ms | 17.7 → 17.5 ms |
| Large / light | 320 | 177.8 → 179.5 ms | 17.5 → 17.7 ms |
| Large / dark | 320 | 164.0 → 177.0 ms | 17.5 → 17.6 ms |
| Expensive / light | 50 | 179.7 → 182.2 ms | 17.9 → 18.7 ms |
| Expensive / dark | 50 | 167.5 → 183.1 ms | 24.3 → 22.8 ms |
| Research paper / light | 11 | 152.3 → 152.5 ms | 17.8 → 17.7 ms |
| Research paper / dark | 11 | 140.8 → 141.2 ms | 18.3 → 17.6 ms |

These short local runs show broadly similar scrolling and mixed startup timings,
including slower observations. They do not establish an overall loading or
scrolling improvement. The first run includes cold module/worker costs; raw
samples retain it. These fixtures range from approximately 1 MB to 16 MB.

After reaching the last page, both versions retain 4–6 visible canvases and
approximately 3.5–4.4 MB of canvas backing pixels in these viewports. Those are
width × height × 4 estimates, not browser heap or GPU memory measurements; cached
bitmaps and PDF.js resources are outside this count. All measured canvases release
their backing dimensions on unmount. Upstream already provides bounded canvas
caches and detail buffers, so this PR preserves them.

Generated 10/100/1,000-page documents additionally test loading scale. The
1,000-page fixture reached its first canvas in 196.1 → 178.0 ms in the hot-path
run, while the 100-page case was 110.5 → 112.1 ms. The durable improvement is the
request bound, rather than that single startup timing.

A dedicated PDF.js experiment compares 16, 32, 64 and effectively unlimited page
requests, alternating order after a warmup. Median page/viewport preparation was
70.9/70.0/71.1/71.5 ms for 1,000 generated pages, and 7.7/7.6/7.3/7.6 ms for the
320-page real PDF. Sixteen requests preserves comparable local throughput with
the smallest tested request population. Network-constrained PDFs may behave
differently. The viewer still waits for all page viewports before mounting.

## Implementation and API behavior

- Search uses two reusable edit-distance rows, a threshold band and early
  rejection. It caches normalized text with weak keys and retains only the best
  requested results. A 20,000-window differential test checks the distance against
  full Levenshtein. Exact matches on one page no longer suppress fuzzy matches at
  the same offset on another; exact-only results can fill the requested limit.
- `useSearch` preserves synchronous `search` and adds `searchAsync`, `cancelSearch`
  and `isSearching`. Both paths share ranking logic. New searches, document-text
  replacement and unmount cancel obsolete async work. Cancellation rejects with
  `AbortError`, and partial/stale results are never published. See the
  [async search example](packages/docs/content/docs/code/search.mdx).
- Document indexing shares one job between consumers, with four active text
  streams. Two consumers of 100 pages create 100 extraction streams, with a peak
  of four. Explicit `getReader()` consumption retains strings rather than a full
  page's text-position objects. This also fixes indexing in the tested WebKit
  version, whose streams lack the async-iteration API used by PDF.js
  `getTextContent()`. Failed jobs can retry; Strict Mode can reuse an active job.
- Highlight positioning reads only through the requested range. Each caller owns
  its stream. PDF.js cancellation receives an `Error` reason and does not wait for
  a worker acknowledgement before returning an already-complete result. Tests
  cover matches across chunks, concurrent consumers and continued extraction.
- Document loading preserves page order, caps page requests at 16, stops scheduling
  after disposal/failure, and ignores late results from replaced documents.
  Download progress no longer drives unused React state.
- `useAnnotations(selector)` allows narrow subscriptions; the no-argument API
  remains available. `usePageAnnotations(pageNumber)` uses one index per immutable
  annotation array, including cross-page highlights/underlines. Unchanged page
  results keep their identity, preventing unrelated layer updates.
- `<Thumbnails virtualize={{ itemHeight: 150, overscan: 2 }}>` opts into a fixed-row
  list with a bounded scroll-container height. Existing layouts remain the default.
  Arrow keys and Home/End mount and focus the requested thumbnail. See the
  [virtual thumbnail example](packages/docs/content/docs/code/thumbnails.mdx).
- Store setters avoid unchanged writes; page widths are memoized by viewport
  identity. Visibility and display-resolution subscribers share native observers,
  with cleanup and older Safari media-query fallbacks.
- Published exports now include `esm-only.cjs`, which was absent from a real
  `pnpm pack` archive. The diagnostic identifies Lector instead of linking to an
  unrelated package. A packed-artifact check verifies every export target,
  CommonJS diagnostics, ESM loading and server rendering.

Selector example:

```tsx
const updateAnnotation = useAnnotations(state => state.updateAnnotation);
const annotationsOnThisPage = usePageAnnotations(pageNumber);
```

## Validation and reproduction

Local validation passed:

- 135 browser tests in each of Chrome, Firefox 132 and Playwright WebKit.
- 8 Node tests, including the seeded distance comparison and cancellation pools.
- 24 real-PDF corpus cases on main and on the PR, plus the concurrency experiment.
- TypeScript, library build, Size Limit, packed-package ESM/CommonJS/SSR checks.

The WebKit run exposed a one-channel gradient-rounding difference in an existing
pixel test. It now compares recolored pixels to an equivalent native gradient in
the same engine, preserving the pixel-level behavior check. CI runs the library
suite in Chromium, Firefox and WebKit and requires the checks before release.
Playwright WebKit on macOS is not physical-device iOS Safari coverage.

```sh
pnpm install --frozen-lockfile
pnpm --filter @anaralabs/lector build
pnpm --filter @anaralabs/lector test
pnpm --filter @anaralabs/lector lint
pnpm --filter @anaralabs/lector bench:performance
pnpm --filter @anaralabs/lector bench:second-pass
pnpm --filter @anaralabs/lector bench:corpus
```

Local Chromium tests use installed Chrome. Install Playwright browsers and select
another engine with `LECTOR_TEST_BROWSER=firefox` or `LECTOR_TEST_BROWSER=webkit`.
Set `CI=1` to use Playwright Chromium locally. Run timing benchmarks separately
from builds or other browser runs. For a clean-main comparison, copy the corpus
fixture and Vitest configs into a detached `675ce1b` checkout; the fixture uses
only APIs already present on main. Baseline hot-path fixtures need the older
expected work counts and omit the opt-in thumbnail prop. No production baseline
source was changed for measurement.

## Remaining opportunities, backed by this pass

| Priority | Evidence | Next work |
| --- | --- | --- |
| High | All 1,000 pages still load before the viewer mounts; isolated page/viewport preparation takes roughly 71 ms despite request tuning. | Introduce progressive page resources with estimated dimensions, initial-page priority, mixed-size correction and deep-link coverage. The current synchronous `getPdfPageProxy` contract needs a coordinated migration. |
| High | Million-character sync search still blocks the input probe for 159.5 ms; async completion takes 273 ms. | Evaluate worker-backed search, persistent normalized indexes and query reuse. Measure transfer/startup overhead and peak memory as well as cancellation latency. |
| Medium | Offscreen edits avoid visible renders, but constructing an index still scans all 10,000 annotations on mutation. | Consider incremental page-index updates for very large or frequently edited collections. Compare actual update rates and retained memory before adding store complexity. |
| Medium | The tested PDFs scroll near a 16.7 ms display interval; expensive dark-mode runs reach p95 around 23 ms. Canvas counts remain bounded. | Profile those specific frames on slower devices before changing rasterization or dark-mode code. Include high zoom, pinch, scanned images and large consumer stylesheets. |
| Medium | Three desktop engines are covered; corpus measurements are local, at a fixed viewport, with no network throttling. | Add physical iOS devices, lower-memory hardware, encrypted/malformed PDFs, mixed rotations, network/range-loading cases and repeated long-session memory measurements. |
| Maintenance | Build reports API Extractor's bundled TypeScript 5.4.2 versus project TypeScript 5.7.2. `Pages` still customizes virtualizer behavior through private methods. | Align declaration tooling with packed consumer validation; replace private virtualizer hooks only with restored-offset, varying-size and gesture regressions in place. |

This is a broad measured pass over loading, indexing, searching, annotations,
page/thumbnail rendering, subscriptions, browser compatibility and packaging.
It is not proof that every workload or future optimization has been exhausted.

## Pre-merge follow-up

After the measured performance commits, main advanced to `41543e9` with rewritten
guides, documentation endpoints and a page-width/selection fix. The merge keeps
those changes and the PR's async-search and virtual-thumbnail documentation.

Review identified a missing error state in `Search`: extraction rejection mounted
children against an empty index. A component regression reproduced this behavior.
`Search` now mounts children only after successful indexing, provides an explicit
error with Retry, and accepts `errorFallback({ error, retry })`. Tests cover failed
indexing, recovery without remounting, and repeated failure through a custom
fallback. The combined suite has 141 browser tests and 8 Node tests. Its rebuilt
Size Limit output is 49,815 bytes. Timing tables above remain measurements of the
original performance pass rather than new measurements of this follow-up.

The imported page-alignment test assumed scaled `getBoundingClientRect()` values,
which older WebKit does not provide for CSS zoom. Physical hit tests confirm the
page is correctly sized and centered. The test now checks both physical edges in
a viewport large enough to contain them; reverting the original centering fix
makes this test fail. All 141 WebKit browser tests pass locally with this check.
