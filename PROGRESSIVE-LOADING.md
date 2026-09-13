# Progressive page loading

This pass adds opt-in `Root progressive` loading. The existing eager mode remains the default. `initialPage` prioritizes a one-based requested page, then the reader mounts while a bounded queue resolves the rest of the document. Native PDF.js proxies remain real resources: synchronous access to an unresolved page throws a descriptive error, and custom consumers can await `loadPdfPageProxy(pageNumber)` or `loadPdfPageProxies()`.

## Measurements

Chrome 153, macOS ARM64, PDF.js 5.5.207. Each row uses one warm-up pair followed by five measured pairs, alternating eager/progressive order. Both conditions use the same current implementation, including the separate scroll/render changes; this isolates the opt-in loading mode rather than comparing two different commits. First-canvas timestamps come directly from the rendered-page store notification, avoiding polling delay.

| PDF and acquisition condition | Eager first canvas, median | Progressive first canvas, median |
| --- | ---: | ---: |
| Generated 1,000-page PDF, local | 197.9 ms | 118.1 ms |
| Real 320-page PDF, local | 153.7 ms | 148.9 ms |
| Generated 1,000-page PDF, 10 ms delay per page request | 874.9 ms | 146.4 ms |
| Real 320-page PDF, 10 ms delay per page request | 398.8 ms | 165.2 ms |

The generated local PDF's post-document phase fell from 89.1 ms to 11.6 ms. The real local document's small first-canvas difference does not establish a meaningful speedup. With delayed metadata, the initial page no longer waits behind every subsequent page; the delay is injected into `getPage()` and is **not** a network-throttling simulation. Actual range requests, network conditions and document structure can produce different results.

Both modes stayed within 16 concurrent page requests. At the first canvas, the generated local progressive run had a median of 79 acquired pages rather than all 1,000; the delayed case had a median of four. All background acquisition completed before each trial unmounted.

Raw samples: [progressive-loading-results-2026-09-10.json](packages/lector/benchmarks/progressive-loading-results-2026-09-10.json).

```sh
pnpm --filter @anaralabs/lector exec vitest run --config vitest.bench.config.ts benchmarks/progressive-loading.browser.test.tsx
pnpm --filter @anaralabs/lector exec vitest run tests/progressive-loading.browser.test.tsx tests/extraction.browser.test.tsx
pnpm --filter @anaralabs/lector test:unit
```

## Behavior and verification

The ten progressive-loading integration cases and five extraction cases pass in Chromium, Firefox and WebKit. Five PageResources unit cases, TypeScript and lint also pass.

- A real PDF with all noninitial page requests held behind a deterministic gate renders its initial canvas in progressive mode. Eager mode remains on its document loader until the gate opens.
- A requested deep-linked page is acquired before any other page. Tests cover initial zoom 0.5, 1, 1.5 and 2, plus fit-width.
- A preceding page's initially estimated height resolves to a different actual height because of its intrinsic PDF rotation. The current reading position stays anchored at each tested zoom. During a pinch, size corrections are deferred; gesture snapshots and corrected offsets retire together before the next paint.
- Unresolved direct thumbnails wait for a real proxy. Page acquisition failures expose Retry and call the existing viewport-generation error callback. Search remains loading until the complete index is available, and page/search retries recover without remounting the viewer.
- Queue tests cover request deduplication, visible-page priority, concurrency bounds, ordered completion, batched immutable viewport snapshots, rejection/retry and disposal. Document replacement ignores late resources from the disposed document. Search still reindexes when page proxies change within one document.

The tests also exposed an existing initial-offset bug: nonunit initial zoom was applied twice to a restored/deep-linked offset. The companion zoom change corrects that initialization, with exact scroll-position tests.

## Compatibility and limits

Progressive loading is optional because unknown page sizes must be estimated. Vertical offsets are corrected as metadata arrives, but a wider page can still change horizontal centering or fit-width zoom. The default eager mode remains appropriate when the first layout must have every exact dimension.

`pageProxies` is empty until the complete ordered array is available in progressive mode; `pagesLoaded` reports that state. Built-in Page, Thumbnail and Search handle unresolved resources. Custom consumers using synchronous page access must adopt the async accessors or keep eager loading.

The queue improves startup scheduling, not eventual memory retention: PDF.js still retains the acquired proxies. It does not implement a PDF worker cache eviction strategy, remote range-request prioritization, streamed partial search results or a new rotation-control interface. Intrinsic PDF page rotations are covered; the existing Root initialRotation limitation is unchanged.
