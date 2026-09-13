# Low-end performance pass — September 13, 2026

Baseline: merged main `d9757fc`, including search fidelity and persistent selection. This pass improves search latency and responsiveness, and adds Windows regression coverage. It does not change rendering quality or claim that CPU throttling reproduces a physical old Windows laptop.

## Measured search improvements

Chrome on macOS ARM64, 6× CPU throttling, default result limit 10. Each condition has two browser batches, each with one warm-up and seven measured samples per scenario (14 retained samples). Baseline and final batches alternate; an intermediate timer-based candidate was rejected. Medians below include cold search normalization, but exclude PDF loading and initial text extraction.

| Workload | Baseline total | Final total | Baseline initial timer delay | Final initial timer delay |
| --- | ---: | ---: | ---: | ---: |
| Real 320-page PDF: first ten `the` matches | 97.45 ms | 0.65 ms | 9.00 ms | 0.75 ms |
| Real 320-page PDF: no match | 65.45 ms | 58.40 ms | 23.85 ms | 8.45 ms |
| Generated 1,000 pages: first ten exact matches | 386.65 ms | 0.10 ms | 10.20 ms | 0.80 ms |
| Generated 1,000 pages: no match | 362.70 ms | 154.15 ms | 32.75 ms | 8.70 ms |
| Generated 100 pages: fuzzy typo | 349.90 ms | 195.15 ms | 9.15 ms | 8.80 ms |

The real document has 607,965 extracted UTF-16 code units; generated workloads contain 1,128,000 and 112,800. Generated pages repeat prose containing ligatures and accents, making them normalization stress fixtures, not a representative document corpus. Early exit benefits queries with enough early matches; it cannot avoid a full scan for missing or rare text. Submillisecond timings should be read as “below 1 ms,” not precise speedup ratios. Batch-to-batch timings vary substantially, especially for the synthetic fuzzy workload; these are descriptive observations, not confidence intervals or universal speed claims.

The timer measurement schedules a zero-delay callback immediately before each search. It detects event-loop blocking, not physical keyboard-to-paint latency. All raw samples and the environment are in [low-end-results-2026-09-13.json](packages/lector/benchmarks/low-end-results-2026-09-13.json).

The changes:

- Exact searches stop after one additional distinct hit proves `hasMoreResults`. Retained matches are already in document order; later pages cannot change them. Zero limits and repeated hits within one expanded ligature retain their previous semantics.
- Async searches check the work budget between pages, including pages with no matches. Previously those pages could repeatedly normalize without reaching the matching-loop yield check.
- MessageChannel tasks avoid nested timer delays while retaining task boundaries for input and cancellation. Both ports close after each yield, including cancelled searches. Environments without MessageChannel retain the timer fallback. Native `scheduler.yield()` was tried but rejected because it delayed the timer-based responsiveness regression; the final implementation uses message tasks.
- Isolated presentation ligatures bypass grapheme segmentation. Combining marks, adjacent non-ASCII runs and other canonical conversions still use the existing grapheme-aware mapping. Segmenter construction is deferred until that path is needed.

## Windows and regression coverage

CI now runs the library's types, unit tests, full browser suite and bundle-size checks in Chromium and Firefox on Windows Server 2022 runners. The Linux Chromium/Firefox/WebKit matrix and packed-artifact/SSR checks remain. This covers actual Windows browser/font/selection behavior, not old consumer hardware or obsolete Windows/browser versions.

The first Windows run exposed a platform assumption in a selection test: native double-click word selection can include the following space. The test now verifies the captured native endpoint, exactly one character of Shift+Arrow extension, and an unchanged anchor. Runtime selection behavior was not changed. Browser dependencies are explicitly pre-optimized after Vite dependency discovery reloaded a test mid-run and caused invalid React hook calls.

Local validation: 37 Node tests, 263 browser tests in each of Chromium, Firefox and WebKit, types, library build, size limit and packed exports/ESM/SSR checks pass. Bundle size changes from 58,292 to 58,416 bytes (+124 bytes). The new regressions failed on the baseline for unnecessary exact-search indexing and missed page-boundary yields; they also cover timer fallback cancellation and ligature source spans.

## Remaining measured bottlenecks

Rendering was profiled separately, with no rendering code changes in this pass. A 4× CPU diagnostic trace of scroll/zoom activity on the large PDF sampled about 1,430 ms in native `drawImage` and 602 ms in `fillText`. Native raster work remains the dominant target; these sampled self-times are not a controlled rendering speed comparison.

Four desktop/DPR-1 scroll/zoom cycles at 6× CPU throttling alternated the real large light PDF and expensive dark PDF. Large-document p95 frame intervals were 96.6 and 78.7 ms; expensive-document intervals were 107.2 and 105.9 ms. The loop jumps across the full document and changes zoom repeatedly, so this is intentionally harsh interaction stress, not ordinary reading. Each cycle left zero tracked live bitmaps after unmounting, at most ten page canvases were mounted, and post-GC renderer heaps ranged from 26.0 to 36.2 MB. This short run does not establish leak-free endurance.

Tracked bitmap allocation peaked around 195–212 MB, including transient entries before eviction. Observed page-canvas allocation peaked around 34–45 MB. These exclude full process, PDF worker and GPU memory. The existing desktop cache's approximately 192 MiB budget deserves a controlled low-memory-device study before changing its eviction/quality tradeoff.

Next investigations, in priority order:

1. Profile image blits, text rasterization and dark-mode mask readbacks on a physical Windows laptop, including integrated graphics and software rendering. Test visible-page-first scheduling and repeated-scale reuse against both steady scrolling and backtracking before changing policy.
2. Measure total process memory and a longer multi-document session on 4 GB hardware. Compare smaller bitmap budgets against re-render CPU and revisit latency; lowering a budget alone is not a proven speed improvement.
3. Move or cooperatively split cold normalization for pathological single pages. This pass yields between pages; one exceptionally dense page can still exceed the time budget. Background text extraction and fuzzy candidate work remain further targets.
4. Add scanned/image-heavy, CJK/RTL/complex-script and malformed-font documents to the measured corpus, plus physical trackpad, keyboard, forms and screen-reader tasks. Existing fixtures are not enough to claim universal fidelity or best-in-class performance.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm --filter @anaralabs/lector exec playwright install chromium
LECTOR_SOAK_CPU_RATE=6 pnpm --filter @anaralabs/lector exec vitest run --config vitest.low-end.config.ts --reporter=verbose --silent=false
LECTOR_SOAK_CPU_RATE=6 LECTOR_SOAK_CYCLES=4 pnpm --filter @anaralabs/lector exec vitest run --config vitest.soak.config.ts --reporter=verbose --silent=false
pnpm --filter @anaralabs/lector exec vitest run --config vitest.scroll-profile.config.ts --reporter=verbose --silent=false
```

The profile harness fixes CPU throttling at 4×. On machines without installed Google Chrome, set `LECTOR_BROWSER_CHANNEL=chromium`. For a baseline comparison, use a separate worktree at `d9757fc` and copy only the new search benchmark and `vitest.low-end.config.ts` into it. Run the identical commands with the same browser and no concurrent builds/tests. This session used frozen baseline search/normalization modules in a local-only Vite alias and shared worktree dependencies via a local allow-list; neither local override is committed. The benchmark is opt-in and makes no machine-dependent timing assertions in CI.
