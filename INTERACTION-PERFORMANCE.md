# Parallel reader performance and fidelity pass

This extends PR #163 beyond the annotation, Unicode and toolbar changes measured in [READER-QUALITY.md](READER-QUALITY.md). The previous PR commit, `93c5bd6`, is the frozen baseline for whole-pass comparisons. Component ablations use the same implementation with one feature disabled, as explicitly identified below.

## Zoom input and navigation

The gesture handler now applies the latest geometry, scroll anchor and store zoom once per animation frame. A 120-event Ctrl-wheel burst over 10,000 positioned text spans fell from **11.2 ms to 1.0 ms** median handler time; total geometry writes fell from **119 to 1**, with the same final width. One warm-up and five measured runs per condition, Chrome 153 on macOS ARM64. This isolates input handling; it excludes PDF rasterization and the full viewer's subscribers. Frame timing is vsync-sensitive and is not the primary claim.

[Raw zoom samples](packages/lector/benchmarks/zoom-input-results-2026-09-10.json) and [reproducible benchmark](packages/lector/benchmarks/zoom-input.browser.test.tsx).

The accompanying regressions cover queued gesture cancellation, final-position flushing, external zoom arriving before the queued frame, WebKit's settled CSS zoom, and nonunit initial zoom. Initial navigation previously scaled the scroll offset twice. Centering a search highlight also mixed physical viewport height with logical offsets; at 50% and 200% zoom the target landed at 125 and 500 pixels instead of the 250-pixel viewport center. It now uses cached logical viewport dimensions without reading layout. At 25% zoom, the virtualizer also mounted only two pages although four intersected the viewport. Its viewport dimensions, offsets and page measurements now share logical PDF coordinates, including zoom changes without a resize. Coverage is checked at 25%, 50%, 100% and 200% in all three browser engines.

## Fast scrolling

PDF.js now defers render continuations for offscreen overscan pages during scrolling. Visible pages and unknown geometry proceed immediately; deferred work resumes on viewport changes or after scrolling settles. Cancellation removes the continuation, subscription and timer. Canvas resolution, device-pixel ratio and bitmap budgets are unchanged.

In a single isolated, CPU-profiled gate-off/gate-on pair with identical corrected viewport geometry, the 320-page PDF's sampled native `drawImage` time fell from **2,075 to 1,237 ms**, and p95 frame interval from **80.9 to 56.9 ms**. The expensive dark PDF improved less: **97.8 to 89.5 ms** p95. This diagnostic pair identifies reduced raster work; profiler overhead and one pair limit the timing claim.

[Raw profiles and ablation instructions](packages/lector/benchmarks/scroll-render-results-2026-09-10.json). The repeated unprofiled stress comparison below evaluates the whole pass, including rendering visible pages omitted by the old low-zoom calculation.

## Repeated scroll/zoom and cleanup stress

Eight cycles per condition alternated the real 320-page light PDF and 50-page expensive dark PDF, giving four samples per document. Each cycle performs 120 full-document back-and-forth scroll steps with 20 zoom changes, then unmounts and samples renderer heap after GC. Chrome mobile emulation uses a 390-pixel viewport, DPR 3 and 4× CPU throttling. The frozen baseline ran first; the final source ran second, with no concurrent builds or browser tests. These are descriptive repeated samples, not confidence intervals.

| Mobile-emulation metric (median across four cycles) | `93c5bd6` | Final |
| --- | ---: | ---: |
| Large PDF p95 frame interval | 68.0 ms | 48.6 ms |
| Large PDF frames over 32 ms, of 120 | 81.5 | 45.5 |
| Large PDF bitmaps created | 360 | 184 |
| Expensive dark PDF p95 frame interval | 81.8 ms | 79.8 ms |
| Expensive dark PDF frames over 32 ms, of 120 | 94 | 87 |
| Expensive dark PDF bitmaps created | 142 | 125 |

The large-PDF p95 interval improved about **28%** in this workload. The expensive dark PDF's small p95 change does not establish a meaningful gain and remains a performance target. The stress loop changes store zoom directly, so this comparison excludes the gesture handler's separate improvement.

Every cycle ended with zero tracked live/pending ImageBitmaps and all surviving observed page canvases resized for release. At most ten page canvases were mounted. Peak visible canvas allocation for the large PDF fell from 89.7 to 71.8 MB; the expensive PDF stayed at 71.8 MB. Its mounted-page peak rose from eight to ten because the corrected viewport now includes pages that should be visible. Peak bitmap allocation was about 80.6–82.9 MB, including the transient bitmap before cache eviction; settled caches remained below the existing 64 MiB mobile budget.

Renderer JS heap after GC was approximately 24.8–25.8 MB for the large PDF and 34.0–34.7 MB for the expensive PDF in the final run, without a sustained upward trend across these short cycles. This does not measure total process memory: PDF workers, native PDF.js scratch canvases and GPU allocations are outside the complete accounting, and asynchronous worker destruction may still be finishing. The harness uses weak canvas references and avoids mock call histories that would themselves retain canvases. Allocation peaks cover the interaction phase after the first ready canvas; frame intervals include harness layout reads and instrumentation.

A three-cycle unthrottled desktop check found large-PDF p95 essentially unchanged (17.2–17.8 ms before, 17.6–17.7 ms after). The single expensive-PDF sample changed from 28.3 to 30.7 ms; this is too little data to establish a regression or improvement. Cleanup assertions passed throughout. No universal desktop speedup is claimed.

[Raw stress samples](packages/lector/benchmarks/reader-soak-results-2026-09-10.json). The baseline passed all assertions but emitted a Vitest teardown-timeout warning before exiting successfully; the final run exited cleanly. This is a short automated stress run, not a physical-phone or 30-minute endurance result.

## Startup and text fidelity

[Progressive loading](PROGRESSIVE-LOADING.md) is opt-in. A generated local 1,000-page PDF reached its first canvas in **118.1 ms versus 197.9 ms** median; the local real 320-page PDF showed only a small difference. Delayed page-metadata acquisition improved substantially, with five alternating measured pairs after warm-up. Unknown sizes remain estimates until acquired; vertical reading position is corrected as dimensions arrive. The demo uses this mode. Keyboard focus now waits for a progressively acquired virtual thumbnail before moving to it.

Highlight geometry now follows actual PDF viewport transforms, crop boxes, rotation, font metrics and proportional boundary-run widths. Eight real-PDF crop/rotation cases went from **1/8 to 8/8** passing against rasterized glyph bounds. Highlights no longer bridge a blank column gutter. Partial-match widths follow PDF.js’s selectable text-layer fallback font: a strict browser DOM Range comparison stays below **1 CSS pixel** of boundary-width error in the regression fixture. Original extraction offsets and whitespace remain intact.

Fallback-font proportions vary by platform. For Helvetica `iiiiWWWW`, the `iiii` error against native PDF advances fell from **28.88 points** to about **0.013 points on macOS**, but remained **2.70 points in Linux Firefox/WebKit CI**. The initial claim of less than 1 point against native Helvetica on every platform was therefore incorrect. The portable regression now compares actual PDF.js selection geometry, retaining the same strict 1-pixel limit; it also verifies that the old equal-character estimate misses that range by more than 20 pixels. No runtime algorithm or tolerance was relaxed to address the CI failure.

[Raw fidelity evidence](packages/lector/benchmarks/highlight-fidelity-results-2026-09-10.json). Complex shaping, mixed-direction runs, unusual font substitutions, ligature normalization, dehyphenation and copied-text fidelity still require a broader corpus; these tests do not establish universal text correctness.

## Reproduction

```sh
pnpm --filter @anaralabs/lector build
pnpm --filter @anaralabs/lector test
LECTOR_TEST_BROWSER=firefox pnpm --filter @anaralabs/lector exec vitest run
LECTOR_TEST_BROWSER=webkit pnpm --filter @anaralabs/lector exec vitest run
pnpm --filter @anaralabs/lector exec vitest run --config vitest.bench.config.ts benchmarks/zoom-input.browser.test.tsx
LECTOR_SOAK_PROFILE=mobile LECTOR_SOAK_CYCLES=8 pnpm --filter @anaralabs/lector bench:soak
LECTOR_SOAK_PROFILE=mobile pnpm --filter @anaralabs/lector exec vitest run --config vitest.scroll-profile.config.ts
```

The standalone Chromium stress/profiling configurations use CDP; they are excluded from the generic corpus benchmark. Timing runs should be isolated from builds and other browser tests. Installed Chrome is used locally; see CONTRIBUTING.md for browser installation.

## Final validation and remaining targets

- 192 browser tests pass independently in Chromium, Firefox and WebKit; 14 Node tests, TypeScript, library build, Size Limit and packed ESM/SSR consumer checks pass.
- Library/docs lint pass, with the two existing annotation-hook dependency warnings unchanged. Production docs build, five agent-docs unit tests and 20 production HTTP checks pass. Next's optional ESLint build integration still reports the existing missing-ESLint message; the repository's Biome lint is the checked linter.
- The production reader passes keyboard paging, zoom, text selection/highlighting, stable-control geometry and responsive target checks at 320, 375, 390, 768 and 1440 pixels. Final light-mode captures were inspected at narrow mobile and desktop widths, plus dark mode at 390 pixels.
- Size Limit's bundled/compressed metric changes from 50,296 bytes at `93c5bd6` to 52,489 bytes (+2,193 bytes). Relative to PR base `67c0823`, the complete PR changes it from 49,815 to 52,489 bytes.

The largest remaining measured target is expensive PDF rasterization under CPU throttling. Next investigations should isolate costly image/transparency/font operations before changing quality or cache policy. Physical iOS/low-memory Android endurance, complex text/copy fidelity, total search CPU cost, and task-based screen-reader/form/navigation checks remain open. No competitor benchmark or claim of best-in-class performance is made.

## September 11 review correction

Automated review identified that the logical scroll offset was only refreshed on native scroll events, while the viewport dimensions already refreshed on zoom. The offset observer now republishes the current physical position divided by the new zoom immediately, preserving its scrolling/idle state. It also cancels its idle timer and store subscription on disposal. Five deterministic regressions failed before the change and pass afterward, covering vertical and horizontal/RTL offsets, scroll-before-zoom ordering, and disposal. The related 35-test suite passes in Chromium, Firefox and WebKit.

The full Chromium suite now has 197 tests. Build, types, unit/package checks and lint pass. The Size Limit metric is 52,510 bytes, 21 bytes above the prior head. Earlier timing measurements in this report predate this correctness fix and have not been substituted with new timing claims.

Current main (`1350375`) was then merged, preserving its security/dependency, selection and hosting changes. The two standalone CDP benchmarks now use Vitest 4's `vitest/browser` and Playwright provider options. The mobile-emulation harness passes a one-cycle compatibility/cleanup smoke test; its timing is not used as a replacement benchmark. The integrated suite contains 212 browser tests. Newer Firefox's native scroll rounding is tested separately from the exact requested coordinates. The merged build's Size Limit metric is 52,695 bytes.
