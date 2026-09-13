# PDF interaction pass — September 13, 2026

Baseline: `72cc84a`, the search/Windows performance PR before these interaction changes. This pass targets the response to input and page continuity. Canvas rendering quality and cache budgets are unchanged.

## Changes and regression evidence

| Before | After | Why |
| --- | --- | --- |
| A single Ctrl-wheel event left zoom unchanged on the next animation frame. | Its scale delta applies on the next frame. | The gesture library already includes movement in the first wheel event; Lector discarded it until another event or gesture end. |
| Zooming out could leave visible pages unmounted throughout the gesture. | Newly exposed pages mount alongside the original gesture snapshot. | Keeping the original page positions preserves the anchor, but freezing the entire mounted list creates holes. The union is bounded by the starting and current virtual ranges, not the path travelled. |
| Moving a pinch midpoint 30 px left and 50 px up left the content behind by those distances. | The scroll anchor follows both axes, with zero error in the regression fixture. | Touch panning must use the current midpoint. Wheel input separately rebases the anchor under the new pointer, including updates queued before a paint. |
| Horizontal trackpad input immediately after wheel zoom was cancelled. | Horizontal-dominant input exits the inertia guard and can pan normally. | Horizontal panning is distinct from the vertical wheel tail the guard suppresses. |

The first three issues were reproduced with browser regressions before their fixes. The pan handoff also failed before its fix. The existing test still verifies 120 gesture updates produce one geometry write per frame. Additional coverage checks wheel anchoring with and without an outstanding animation frame, toolbar zoom, restored offsets, unmount cleanup, and visible pages during an active gesture.

## Real-PDF measurements

Chrome 153 on macOS ARM64, desktop DPR 1, **6× CDP CPU throttling**. The two fixtures are the real 320-page `large.pdf` in light mode and 50-page graphics-heavy `expensive.pdf` in dark mode. Each baseline/final condition has two browser batches; each batch opens each document four times and excludes its first trial from the median (six retained samples per condition/document). Runs were sequential with no concurrent builds or tests. An additional exploratory candidate batch preceded the final wheel-anchor fix and is not used below.

| Measurement | Large baseline | Large final | Graphics-heavy baseline | Graphics-heavy final |
| --- | ---: | ---: | ---: | ---: |
| Single wheel event → matching viewport geometry/store zoom | 144.30 ms | 9.65 ms | 151.80 ms | 16.95 ms |
| Visible pages missing from the mounted list during 25% zoom | 2 | 0 | 2 | 0 |
| First canvas ready on repeated document open | 216.70 ms | 221.35 ms | 321.95 ms | 317.65 ms |
| Continuous-scroll p95 frame interval, median across trials | 18.75 ms | 19.55 ms | 31.35 ms | 30.20 ms |

Wheel latency ends when the store publishes zoom, after the viewport geometry has been applied. It measures input response, not completion of sharp PDF rasterization or physical display presentation. Continuous scrolling advances 24 px per animation frame for 90 frames (2,160 px), unlike the existing soak benchmark's full-document jumps. Zoom coverage holds the store's gesture state active to isolate mounting behavior from device-specific touch delivery; it measures mounted page presence, not finished page pixels. Mounting starts the missing pages' rendering without waiting for pinch end.

First-canvas measurements include document loading, progressive reader mounting and page rendering, but exclude initial PDF.js module import and use local fixture URLs with browser caching. They are not cold network startup measurements. The timing batches varied, especially for graphics-heavy first paint; all trials, including warm-ups, are retained in [the raw results](packages/lector/benchmarks/interaction-results-2026-09-13.json). These samples establish a wheel-response improvement, not a loading or steady-scrolling speedup. CPU throttling does not reproduce an old Windows laptop's GPU, memory or input hardware.

## Validation

269 browser tests pass in each of local Chromium, Firefox and WebKit. One Firefox native-selection-cleanup test failed when all browser engines ran concurrently; the complete Firefox suite passed on its own without modifying that test or selection code. Build, types, 37 Node tests, size limit and packed-package ESM/SSR checks pass. Lint retains the two existing annotation-hook warnings. The interaction changes add 81 compressed bytes (58,470 → 58,551).

## Reproduce

```sh
pnpm install --frozen-lockfile
LECTOR_SOAK_CPU_RATE=6 pnpm --filter @anaralabs/lector exec vitest run --config vitest.interaction.config.ts --reporter=verbose --silent=false
```

The default local browser is installed Google Chrome; use `LECTOR_BROWSER_CHANNEL=chromium` with a Playwright Chromium installation when necessary. For a baseline, create an isolated checkout at `72cc84a`, copy `benchmarks/interaction-feel.browser.test.tsx` and `vitest.interaction.config.ts` into it, and run the same command. The measurement session alternated baseline and final batches by restoring the two baseline runtime files, then restoring final source before each final batch.

## Remaining work for loading, scrolling and panning

- Measure genuinely cold startup over constrained networks: shell visibility, first useful page pixels, loading feedback, and cancellation when switching documents. The repeated-open benchmark above does not answer this.
- Profile visible-page rasterization and blank-pixel time during rapid scroll/backtracking on physical low-memory Windows hardware. Image blits and dark-mode raster work remain the measured heavy paths in [the earlier report](LOW-END-PERFORMANCE.md).
- Exercise physical touchscreens and trackpads, mixed wheel delta modes, extreme zoom, boundary panning and narrow split panes. The current pass covers gesture math and browser integration; it does not establish device-wide interaction polish.
