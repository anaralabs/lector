`attention-page-3.json` contains PDF.js text content and viewport geometry from page 3 of *Attention Is All You Need* (https://arxiv.org/abs/1706.03762). It was extracted from the demo's existing `attention-is-all-you-need.pdf` using PDF.js 5.5.207. It reproduces the Encoder/Decoder paragraph layout in the September 13 CleanShot recording without requiring a PDF download or embedding the full paper.

The selection tests render this content through the production `TextLayer` hook and PDF.js renderer. Playwright sends real mouse input; assertions check the browser's native selection text, anchor, and focus. Smaller synthetic PDF text streams cover individual edge cases.

Run from the repository root:

```sh
pnpm --dir packages/lector test:browser
LECTOR_TEST_BROWSER=firefox pnpm --dir packages/lector test:browser
LECTOR_TEST_BROWSER=webkit pnpm --dir packages/lector test:browser
```

Chromium uses local Chrome by default, or bundled Chromium in CI. Install the matching Playwright browsers for Firefox/WebKit. `PLAYWRIGHT_BROWSERS_PATH` and `LECTOR_BROWSER_CHANNEL` can override local browser discovery.
