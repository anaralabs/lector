# Persistent PDF selection

A selection used to disappear when scrolling evicted its endpoint's text layer. The regression starts with “Page 1 line 1:”, scrolls to page 11 with overscan zero, and observes `getText()` becoming `null`. It now retains the quote and restores the native selection when page 1 returns.

## Behavior

- Page/text anchors live in the document store. Mounted text layers project the visible part into the browser selection; removing a layer does not remove the logical selection.
- Forward and backward mouse dragging autoscroll across virtualized pages. Active selections bypass text-layer build/hide delays. Native double-click word selection remains available. Shift-arrow extension can restore an offscreen endpoint, and Escape clears the selection.
- Missing selected pages are read using temporary PDF.js text layers, with two concurrent workers and cancellation. Text, explicit line breaks, and page-relative rectangles are retained; temporary layers and detached native endpoints are released. Selected canvases are never pinned.
- Rectangles come from per-text-node browser ranges. Partial proportional-font ranges retain glyph widths, and independent runs are not merged across column gutters. Explicit unrotated text-layer dimensions also fix rotation when the host omits PDF.js scale-round CSS variables.
- Copy and existing selection-dimension helpers consume the complete model. Copy is cancelled while selected pages are loading, preventing silently truncated quotes. Native copy opt-out, custom copy handlers, form fields, and viewer isolation remain supported.
- `usePdfSelection()` exposes reactive status, restoration/clearing, synchronous results, and an asynchronous complete result. Invalid anchors fail explicitly; an async request rejects with `AbortError` if its selection changes. The selection guide demonstrates disabling an action until the result is ready.

## Implementation

`PDFSelectionController` owns selection lifetime, browser projection, input coordination, and missing-page work. `SelectionPage` converts between text offsets, browser text nodes, and scale-1 page rectangles. The store owns one controller per document; `Pages` connects it to the viewport and text layers register/dispose their DOM representations.

The model stores one-based page numbers and UTF-16 offsets in concatenated selectable text, excluding BR elements and preceding copy normalization. Persist anchors with the document identity: a changed PDF or different text extraction can change offsets. Cached strings and rectangles grow with the selected range, while mounted page DOM remains bounded by the virtualizer.

The controller uses native caret hit testing and selection extension so proportional fonts and browser text shaping remain authoritative. It does not infer a new reading order from geometric proximity.

## Validation

The 16 new browser regressions use generated real PDFs and the PDF.js stylesheet. They cover eviction/restoration, missing intermediate pages, copy payloads, both drag directions with native Playwright mouse input, double-click word selection, offscreen keyboard extension, rotations, proportional glyph widths, column gutters, cancelled work, invalid anchors, toolbar/form behavior, separate viewers, native clearing, and synthetic touch-scroll events.

All 226 browser tests pass independently in Chromium, Firefox, and WebKit. All 32 Node tests pass. Type checking, the library build and size limit, packed exports (including the new hook), ESM import, the CommonJS diagnostic, SSR, and the docs production build pass. Lint has only the two existing annotation-hook dependency warnings. Compressed bundle size changes from 53,936 to 57,656 bytes (+3,720 bytes).

The existing corpus, rendering, search, annotation, and performance regressions run alongside the selection cases. Clipboard coverage inspects copy-event payloads; it does not paste into desktop applications.

## Remaining work

This follows PDF.js text order. Malformed column/table/footnote reading order, OCR for scans, and a broader complex-script corpus remain separate work. Browser ranges are more accurate than proportional character estimates but do not repair bad font mappings or source text. Native touch handles are retained; synthetic touch events and desktop WebKit do not certify physical iOS/Android selection-handle behavior. Multiple disjoint ranges and cross-viewer selections are outside the persistent model.
