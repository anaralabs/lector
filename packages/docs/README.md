# Lector documentation

This package is the Next.js and Fumadocs site for Lector. It consumes the local `@anaralabs/lector` workspace package and contains both written guides and interactive PDF examples.

## Run the site

From the repository root, using Node.js 22.13+ and pnpm 9.5.0:

```bash
pnpm install --frozen-lockfile
pnpm --filter @anaralabs/lector build
pnpm --filter docs dev
```

Open [localhost:3000/docs](http://localhost:3000/docs). For library changes, also run `pnpm --filter @anaralabs/lector exec tsup --watch` in another terminal. No yalc setup is needed.

## Edit a guide

| Location | What to change |
| --- | --- |
| `content/docs/index.mdx` | Documentation entry point and task map |
| `content/docs/meta.json` | Top-level sidebar order and sections |
| `content/docs/code/meta.json` | Feature recipe order |
| `content/docs/**/*.mdx` | Guide content; filename determines the URL |
| `components/` | Live feature demos imported by MDX pages |
| `components/example-root.tsx` | Shared live-example theme, fit-width defaults, and viewer styling |
| `public/pdf/` | Shareable PDFs used by demos |
| `lib/setup.ts` | PDF.js worker and stylesheet setup for this site |
| `app/docs/[[...slug]]/page.tsx` | Rendering, table of contents, and page metadata |

Use frontmatter with `title` and `description`. Keep the description specific to what the reader will accomplish. Use language-tagged code fences and a `title="filename.tsx"` when the snippet is a complete file. The default Fumadocs MDX components are supplied by the docs page renderer.

Link pages using site-relative URLs such as `/docs/installation`, not relative `.mdx` paths. `index.mdx` maps to `/docs`; the `code` directory groups recipes in the sidebar and does not itself define a `/docs/code` page. Keep existing recipe filenames when reorganizing navigation so external links survive.

Standalone snippets should use the setup module described in the installation guide. `@/lib/setup` is an alias in this docs app, not a module available to library consumers. Explain where fragments belong rather than referring to undefined local components.

## Check the result

```bash
pnpm --filter docs build
pnpm --filter docs lint
```

The build validates MDX, imports, routes, and the application's TypeScript. It does not type-check fenced TypeScript examples. Validate changed complete examples against the built library separately, then inspect the page in the browser, including the sidebar, headings, code blocks, tables, and live demo. Check a narrow viewport and follow new links.

Fumadocs generates `.source/`; Next.js generates `.next/`. Neither should be committed. Use the root workspace lockfile for dependency changes, even though this directory contains a historical lockfile.

## Live-example regression check

All live examples use `ExampleRoot`, which follows the docs theme and starts in fit-width mode. Use theme tokens for controls and panels as well as passing the document color scheme. Keep example-specific sidebars shrinkable or stack them at narrow widths.

With the docs server running, run this from the repository root:

```bash
DOCS_URL=http://localhost:3000 pnpm --filter @anaralabs/lector exec node scripts/check-docs-examples.mjs
```

The script uses the library's Playwright dependency. Install its Chromium browser with `pnpm --filter @anaralabs/lector exec playwright install chromium`, or set `PLAYWRIGHT_EXECUTABLE_PATH` to an existing Chromium executable. It checks all nine recipe routes at desktop and phone widths for centered pages, horizontal clipping, and actual canvas pixel changes through dark → light → dark theme switches. Set `DOCS_SCREENSHOTS` to an output directory to capture the rendered pages.

## PDF.js webpack compatibility loader

`lib/pdfjs-webpack-patch.cjs` is enabled by `next.config.mjs` in development. It works around a nested PDF.js webpack bundle declaring `__webpack_exports__` inside Next.js's eval wrapper, which can cause `Object.defineProperty called on non-object`.

The loader inserts a no-op reference so webpack's scope analysis can rename the inner variable. Background: [webpack issue #20095](https://github.com/webpack/webpack/issues/20095) and [upstream fix #20097](https://github.com/webpack/webpack/pull/20097).

When upgrading Next.js, verify the bundled webpack includes the fix and test the PDF demos in development before removing the loader and config rule together. A successful production build alone does not exercise this development-only workaround.

For the broader local workflow and PR conventions, see [CONTRIBUTING.md](../../CONTRIBUTING.md).
