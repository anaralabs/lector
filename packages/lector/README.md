# Lector

**A headless PDF viewer for React.** Compose pages, text selection, search, and annotations into your own reading experience. Lector handles PDF.js rendering and page virtualization; you control the layout and UI.

[Documentation](https://anara.com/lector/docs) · [Live demo](https://anara.com/lector) · [npm](https://www.npmjs.com/package/@anaralabs/lector) · [Contributing](https://github.com/anaralabs/lector/blob/main/CONTRIBUTING.md)

## Get a PDF on screen

Use React 19+. The current source expects `pdfjs-dist` `^5.5.207`. These docs track `main`; check the [releases](https://github.com/anaralabs/lector/releases) against your installed package version.

```bash
npm install @anaralabs/lector pdfjs-dist@^5.5.207
```

Copy the PDF.js worker from your app's installed dependency to its public assets. Recopy it whenever you update PDF.js so the runtime and worker versions match.

```bash
mkdir -p public/pdfjs
cp node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs public/pdfjs/
```

Put a PDF at `public/sample.pdf`, then add this browser-rendered component:

```tsx
import { CanvasLayer, Page, Pages, Root, TextLayer } from "@anaralabs/lector";
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import "pdfjs-dist/web/pdf_viewer.css";

GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

export default function PDFViewer() {
  return (
    <Root
      source="/sample.pdf"
      style={{ height: 600 }}
      loader={<p role="status">Loading PDF…</p>}
    >
      <Pages>
        <Page>
          <CanvasLayer />
          <TextLayer />
        </Page>
      </Pages>
    </Root>
  );
}
```

For **Next.js**, load the viewer through a Client Component using `dynamic(..., { ssr: false })`; keep PDF.js setup inside the dynamically loaded module. See [installation](https://anara.com/lector/docs/installation) for the full wrapper, Vite worker setup, and deployments below a path prefix.

`Root` loads the document and provides its state. `Pages` owns scrolling and clones one `Page` template for visible pages. `CanvasLayer` paints the PDF; `TextLayer` adds selectable text. Give the viewer a definite height and import the PDF.js stylesheet so its layers align.

## Build the reader your app needs

| Feature | Start here |
| --- | --- |
| Toolbar, page input, and layout | [Your first viewer](https://anara.com/lector/docs/basic-usage) |
| Authenticated URLs, local files, errors, and self-hosted assets | [Loading documents](https://anara.com/lector/docs/document-loading) |
| Page navigation and fit width | [Navigation](https://anara.com/lector/docs/code/page-navigation), [zoom](https://anara.com/lector/docs/code/zoom-control) |
| Page previews | [Thumbnails](https://anara.com/lector/docs/code/thumbnails) |
| Text search and highlighted results | [Search](https://anara.com/lector/docs/code/search) |
| Selection and citation regions | [Selection](https://anara.com/lector/docs/code/select), [highlights](https://anara.com/lector/docs/code/highlight) |
| PDF links and editable form fields | [Links](https://anara.com/lector/docs/code/links), [forms](https://anara.com/lector/docs/code/pdf-form) |
| Dark page rendering | [Dark mode](https://anara.com/lector/docs/dark-mode) |
| Props, hooks, and defaults | [API reference](https://anara.com/lector/docs/api) |

Lector is a toolkit rather than a finished toolbar or a PDF editor. Your app supplies accessible controls, error UI, and storage for user annotations. Search requires embedded text; it does not perform OCR. Custom highlight overlays do not automatically modify the PDF file. See [troubleshooting](https://anara.com/lector/docs/troubleshooting) for worker errors, blank pages, and layout issues.

## Use with a coding assistant

Connect an MCP client to `https://anara.com/lector/mcp` using Streamable HTTP, with no API key. It can search and read every guide through tools and resources. See [AI agents and MCP](https://anara.com/lector/docs/agents) for setup and example requests.

For direct fetching, start with [llms.txt](https://anara.com/lector/llms.txt), read [individual Markdown guides](https://anara.com/lector/docs/installation.md), or use the [complete documentation](https://anara.com/lector/llms-full.txt). These exports are generated from the same source as the website.

## Work on Lector

From the repository root, with Node.js 22.13+ and pnpm 9.5.0:

```bash
pnpm install --frozen-lockfile
pnpm --filter @anaralabs/lector build
pnpm --filter docs dev
```

Open [localhost:3000/docs](http://localhost:3000/docs). The docs app uses the local workspace package. For watch mode, validation commands, and testing in another application, read [CONTRIBUTING.md](https://github.com/anaralabs/lector/blob/main/CONTRIBUTING.md).

## Acknowledgements

Inspired by [react-pdf-headless](https://github.com/jkgenser/react-pdf-headless) and [pdfreader](https://github.com/OnedocLabs/pdfreader). Built on [PDF.js](https://mozilla.github.io/pdf.js/) and [React](https://react.dev/).

## License

[MIT](https://github.com/anaralabs/lector/blob/main/LICENSE) © [Anara](https://anara.com)
