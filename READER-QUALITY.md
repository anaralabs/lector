# Reader quality pass — September 10, 2026

This first follow-up was measured at `93c5bd6`, starting from `67c0823` after performance PR #159 merged. The subsequent parallel pass is documented in [INTERACTION-PERFORMANCE.md](INTERACTION-PERFORMANCE.md) and [PROGRESSIVE-LOADING.md](PROGRESSIVE-LOADING.md). It preserves the existing reader design and public APIs, with an additive optional search-result field.

## Measured changes

| Check | Main | This pass |
| --- | ---: | ---: |
| 100 offscreen comment edits, 10,000 annotations | 46.3 ms median | 12.3 ms median |
| Visible annotation tooltip renders after one offscreen edit | 0 | 0 |
| 100,000-character exact search | below timer resolution | below timer resolution |
| Short fuzzy search | 4.1 ms | 3.7 ms |
| Phrase fuzzy search | 28.8 ms | 28.1 ms |
| Mobile toolbar icon target | 28 × 36 px | 44 × 44 px |
| Size Limit bundled/compressed metric | 49,815 bytes | 50,296 bytes |

Annotation measurements use Chrome 153 on macOS ARM64, 10 annotations per page across 1,000 pages, 20 subscribed page selectors, 100 updates per batch, one warm-up batch and seven measured batches. Each edit uses React `act`. This is about **3.8× faster** for this workload; it is not a whole-viewer speedup. Search timings are regression checks: the small differences do not establish an improvement.

Raw samples and methodology: [reader-quality-results-2026-09-10.json](packages/lector/benchmarks/reader-quality-results-2026-09-10.json). The baseline and after timings were captured with the same fixture before and after the implementation change. Full-suite repetitions also passed, but are not substituted for this comparison.

The annotation store carries its lazy page index forward through edits, updating affected lists and retaining immutable prior snapshots. Comment/color changes no longer rebuild geometry membership for every annotation. Missing-ID and unchanged updates avoid subscriber notifications. The public annotation array still requires an O(n) pass; moving an annotation onto a new page rebuilds that page's ordered membership. This does not claim constant-time edits.

## Correctness and interaction fixes

- Searching `document` in `İ document` previously returned offset 3 instead of 2. Lowercasing expands `İ` into two UTF-16 units. Search now maps both ends of the match back to the original PDF text, including fuzzy results and snippets. Repeated matches and context-sensitive Greek lowercasing are covered. Ordinary text retains the existing fast path; offset arrays are allocated only for pages whose lowercase length changes.
- The additive `SearchResult.matchLength` preserves the original matched span when its length differs from the query, including shorter fuzzy tail matches. `calculateHighlightRects` and internal result processing honor it. Existing caller-created results still fall back to `searchText.length` or `text.length`. This does not add diacritic-insensitive, ligature, or dehyphenated matching.
- Thumbnails now have default page labels, expose the current page to assistive technology, activate on Enter and Space, prevent Space from scrolling the sidebar, and honor canceled custom handlers. Space activates on release and loses its armed state on blur. Existing virtualized Arrow/Home/End navigation remains covered.
- The demo reserves the Clear highlights action so adding a selection does not shift controls. Mobile controls have 44 px targets, and narrow screens use two deliberate rows with the document title. At 390 px the controls fit one row. Keyboard paging, zoom, selection, highlight creation/clearing, and stable control geometry are exercised against the actual production reader.

## Validation and reproduction

- 146 browser tests pass independently in Chromium, Firefox and WebKit.
- 9 Node unit tests, TypeScript, library build, Size Limit and packed ESM/SSR consumer checks pass.
- Library and docs lint pass (two pre-existing dependency warnings in `useAnnotationLayer`). Production docs build, 5 agent-docs unit tests and 20 production HTTP integration checks pass.
- Reader interactions and visual inspection at 320, 375, 390, 768 and 1440 CSS pixels, plus dark-theme inspection at 390/1440 and visible keyboard focus; mobile target dimensions and absence of horizontal overflow are asserted. Desktop WebKit coverage does not replace physical iOS testing.

```sh
pnpm --filter @anaralabs/lector build
pnpm --filter @anaralabs/lector test
pnpm --filter @anaralabs/lector exec vitest run tests/annotations.browser.test.tsx tests/performance.browser.test.tsx
LECTOR_TEST_BROWSER=webkit pnpm --filter @anaralabs/lector exec vitest run
LECTOR_TEST_BROWSER=firefox pnpm --filter @anaralabs/lector exec vitest run
# Install Playwright browsers as described in CONTRIBUTING.md.

pnpm --filter docs build
pnpm --filter docs start --port 3018
# In a second terminal, with Chrome installed:
LECTOR_READER_URL=http://localhost:3018 node packages/lector/scripts/check-reader.mjs
# Set LECTOR_SCREENSHOTS to save the viewport captures.
```

## Investigations identified before the parallel pass

This historical list motivated the subsequent parallel pass. Progressive loading, several highlight geometry defects, zoom continuity, and emulated-device stress coverage are now addressed in the linked reports. The remaining gaps include complex text shaping/copy fidelity, total search cost, physical-device endurance, and broader reading workflows.

1. **Make the first requested page usable before acquiring every page.** `usePDFDocumentContext` still awaits every proxy/viewport before mounting the viewer. The previous audit measured roughly 77 ms in the post-document startup phase on a generated 1,000-page local PDF; network-delayed page resources need a separate baseline. Introduce a page-resource boundary with priority for the initial/deep-linked page, bounded background acquisition, cancellation and explicit failure states. Preserve the synchronous `getPdfPageProxy` contract for existing consumers. Mixed page dimensions, rotations, fit-width and scroll-anchor corrections must be proven before enabling progressive resources by default.
2. **Make text fidelity a release gate.** Add real PDFs containing ligatures, combining marks, RTL runs, vertical text, rotated pages, columns, and hyphenated line breaks. Search extraction currently concatenates text items, and highlight geometry estimates character width from an item's total width. Establish expected search offsets, copied text and highlight geometry for each fixture before replacing these assumptions. This is central to reading quality, not a cosmetic detail.
3. **Reduce total search work while preserving responsiveness.** The million-character cooperative search test in this pass let the queued input callback run in 8.2 ms, but took 298.1 ms overall versus a 166.0 ms synchronous input delay. Profile persistent indexing/worker execution and scheduling overhead, including cold setup, cancellation and memory. Keep shared indexing and result ordering intact. A worker should earn its bundle/lifecycle cost in measurements.
4. **Test sustained use on constrained devices.** Repeat real-PDF scroll/zoom/annotation sessions for 30 minutes on physical iOS and a low-memory Android device. Measure frame intervals, long tasks, peak/settled canvas allocation, heap growth after document replacement, and background/foreground recovery. The earlier expensive dark-mode corpus case reached about 23 ms at p95 frame interval; that is a profiling target, not evidence that all scrolling is smooth.
5. **Polish the full reading loop.** Check zoom anchored under the cursor/pinch, reading position across resize and sidebar changes, navigation history/back to a citation, selection across page boundaries, forms, password/error recovery and focus restoration. Add task-based keyboard/screen-reader checks alongside the rendering tests. The landing demo should eventually demonstrate these capabilities without putting every control on screen at once.

For comparative claims, run the same public corpus, hardware, cold/warm cache states, network profile and reading tasks against named reader versions. No competitor comparison has been performed in this pass; “best” needs that evidence and real reader feedback.
