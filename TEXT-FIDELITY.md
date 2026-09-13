# Search and copied-text fidelity

This change builds on reader-quality PR #163, now merged into main (`3d59edc`). It improves equivalent-text matching and preserves line boundaries when reading a selection. It does not implement full PDF reading-order reconstruction.

## Reproduced failures

Before the fix, `tests/text-fidelity.test.ts` failed all six initial cases: exact search missed `ofﬁce` / `office`, canonically equivalent accents in both directions, a word containing a soft hyphen, whitespace across a line break, and a phrase split across two PDF.js text chunks with `hasEOL`.

The browser selection test also failed at the actual annotation API. Selecting `My ofﬁce` and `café study.` on separate lines returned `My ofﬁcecafé study.`. The cause was `Range.toString()`, which does not include the PDF.js `<br>` elements, combined with missing Unicode cleanup.

## Behavior

- Search uses canonical Unicode equivalence, Latin presentation ligatures, discretionary soft-hyphen removal, and normalized whitespace. These are exact matches, not fuzzy fallbacks.
- `matchDiacritics: false` additionally folds Latin, Greek and Cyrillic accents. It does not remove Indic vowel signs or convert mathematical compatibility symbols to ordinary digits.
- `ignoreHyphenation: true` joins a hard hyphen at a line ending to a lowercase continuation. This is opt-in because compound words can also end a line. Inline hyphens and explicit blank lines remain intact.
- The text index retains PDF.js line boundaries as optional `PageText.lineBreaks`. Its original concatenated strings and UTF-16 offsets stay unchanged, preserving the existing highlight contract. Chinese/Japanese wrapping between Han/kana characters adds no word separator.
- Sparse mapping records translate normalized match boundaries back to full original glyph spans. Normalization variants are cached per page with weak ownership. Ordinary unchanged text has no mapping records; storage is proportional to changed runs rather than every character. Equivalent hits within a single expanded ligature are deduplicated.
- `Pages` now handles PDF copy events with plain text. Defaults preserve line/page breaks, case, accents and mathematical symbols. It honors cancelled events and editable controls. `copyOptions={false}` retains native copying, including native rich-text behavior. Prose joining is available through `{ lineBreaks: "space", ignoreHyphenation: true }`.
- `useSelectionDimensions().getText(options?)` reads the selected mounted PDF text without calculating geometry. The existing geometry/annotation helpers use the same default cleanup for supported selections.

Copy reads the text-layer DOM in PDF.js order, clips both endpoints, preserves `<br>` boundaries, and excludes controls between pages. Page separators reuse trailing PDF.js line breaks so cross-page copies do not add extra blank lines; existing source blank lines are preserved. A single copy listener is shared per owner document and removed when the final viewer unmounts. No new work runs on scroll or selectionchange.

## Validation

- 32 Node tests pass, including 18 new text-fidelity cases.
- All 240 browser tests pass independently in Chromium, Firefox and WebKit, including 23 new browser cases.
- Generated real PDFs cover phrase search and dehyphenation through PDF.js extraction and highlight calculation at all four rotations with a crop box. Existing raster and selectable-text geometry checks also pass.
- Browser selection tests cover quote text, partial and cross-page ranges, PDF-only copy, controls, viewer isolation, opt-out, updated options, cleanup, and logical Unicode order. Clipboard tests inspect copy-event payloads; they do not automate pasting into native desktop applications.
- Library types, build, size limit, packed ESM import, CommonJS diagnostic, and SSR checks pass. The docs production build and six docs tests pass. Lint has no new errors; the existing two annotation-hook dependency warnings remain.
- Bundled/compressed size: 52,877 → 54,409 bytes (+1,532 bytes).

```sh
pnpm --filter @anaralabs/lector test:unit
pnpm --filter @anaralabs/lector test:browser
LECTOR_TEST_BROWSER=firefox pnpm --filter @anaralabs/lector test:browser
LECTOR_TEST_BROWSER=webkit pnpm --filter @anaralabs/lector test:browser
pnpm --filter @anaralabs/lector build
pnpm --filter @anaralabs/lector test:types
pnpm --filter @anaralabs/lector test:package
pnpm --filter docs build
```

Install the matching Playwright browsers as described in `CONTRIBUTING.md`. This workspace reused dependencies from the existing performance worktree, with a local-only Vite allow-list override for their absolute paths; the override is not part of the change.

## Remaining text-fidelity work

Selection still depends on mounted text layers. `getText` returns null for skipped pages or selections spanning viewers; the copy handler leaves those events to the browser. It does not materialize missing pages or persist selection endpoints across virtualization.

Columns, tables, footnotes, incorrect PDF reading order, complex-script glyph geometry, and physical Windows/touch selection need additional fixtures and implementation. The Unicode preservation tests are not a claim that complex shaping is solved. Scans still need OCR supplied externally. Search still works page by page, and dense-page normalization is synchronous even when the matching API is cooperative. Unicode conversions use `Intl.Segmenter`; older browser targets need a polyfill.

The prevention mechanism for these failures is a shared normalization and source-offset contract, exercised both with text fixtures and with actual PDF.js extraction/highlights. The next substantial step is an explicit selection model with document/page/text anchors that survives virtualization, followed by a reading-order corpus for complex layouts.
