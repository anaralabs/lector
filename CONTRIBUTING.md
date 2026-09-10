# Contributing to Lector

Use the docs app to develop against the local library. It already consumes `@anaralabs/lector` through `workspace:*`, so you do not need a global package link or yalc for the normal workflow.

## Set up a checkout

Use Node.js **22.13 or later in the 22.x line** and **pnpm 9.5.0**, the version pinned in the root `packageManager` field. The local PDF.js dependency declares Node `>=20.19.0 || >=22.13.0`; older Node 18 setup instructions are obsolete.

```bash
git clone https://github.com/anaralabs/lector.git
cd lector
pnpm install --frozen-lockfile
pnpm --filter @anaralabs/lector build
pnpm --filter docs dev
```

Open [localhost:3000/docs](http://localhost:3000/docs). Installation runs the library's `prepare` build and generates Fumadocs content types; the explicit build also runs the package size check. No application secrets are needed to run the docs locally.

If you use a separate worktree, install from that worktree's root so its workspace package links point to the right checkout.

## Make a change

For library development, run these in separate terminals from the repository root:

```bash
pnpm --filter @anaralabs/lector exec tsup --watch
```

```bash
pnpm --filter docs dev
```

The library watcher rebuilds the distribution consumed by the docs app. For docs-only changes, the docs server is enough after the initial library build. Visit the feature page you are changing and test the interaction with an appropriate PDF.

The package's `pnpm dev` script invokes `yalc push` after each successful build. Use the direct `tsup --watch` command above for workspace development unless you specifically need yalc.

## Where things live

| Path | Purpose |
| --- | --- |
| `packages/lector/src/index.ts` | Public exports; start here when checking API availability |
| `packages/lector/src/components/` | Root, page composition, controls, and layers |
| `packages/lector/src/hooks/` | Document loading, rendering, search, selection, and navigation |
| `packages/lector/src/internal.ts` | Per-document viewer store |
| `packages/lector/src/lib/` | PDF.js loading, colors, canvas helpers, and shared utilities |
| `packages/docs/content/docs/` | Published MDX guides and sidebar metadata |
| `packages/docs/components/` | Interactive feature examples |
| `packages/docs/public/pdf/` | PDFs used by the docs examples |
| `examples/basic/` | Standalone Vite consumer of the published package |

The root pnpm workspace includes `packages/**`. `examples/basic` is outside it and has its own dependency installation and lockfile. Its default dependency is `@anaralabs/lector: latest`, so running it does not automatically test your local source.

## Validate your change

Run commands from the repository root:

| Change | Checks |
| --- | --- |
| Library implementation | `pnpm --filter @anaralabs/lector build` and the relevant unit/browser tests |
| Docs pages or examples | `pnpm --filter docs build` after building the library |
| Agent exports or MCP | `pnpm --filter docs test:agents`, then `test:agents:integration` against a production docs server |
| Formatting and lint | `pnpm lint` (the current CI check); for docs specifically, also run `pnpm --filter docs lint` directly |
| Package size | `pnpm --filter @anaralabs/lector test:size` after building |
| Full library test scripts | `pnpm --filter @anaralabs/lector test` |

The current `test:unit` script runs Vitest in browser mode using Chrome and WebdriverIO, including files whose tests look like ordinary unit tests. Have Chrome available. To focus a run, use `pnpm --filter @anaralabs/lector exec vitest run src/lib/dark-mode.test.ts`, replacing the path with the relevant file.

A library build writes `packages/lector/size.json`. Review that diff rather than committing incidental size changes with docs edits. Report existing failures separately from failures caused by your change; do not describe a partial test run as a full pass.

For docs, verify the rendered page as well as the build: copy the setup into an app, follow every new internal link, and check wide code blocks and tables at a narrow viewport. The MDX build parses fenced code but does **not** type-check TypeScript inside those fences. Type-check complete examples against the built package when changing API usage.

## Keep documentation reliable

Write around a reader's task and the behavior they can observe. A recipe should state prerequisites, provide its imports, explain where it belongs in the provider tree, and show the required layout. Label a partial fragment as an addition to an existing viewer.

Check defaults and callback payloads against the implementation, not only comments or older examples. Call out material limits: one-based page numbers, stable source references, virtualized DOM, in-memory overlays, and full-document search indexing. Avoid promising persistence or PDF editing when the example only updates viewer state.

Preserve existing page URLs when reorganizing the sidebar. Add pages to `meta.json` explicitly and link the next useful task. See the [docs maintainer guide](packages/docs/README.md) for file conventions.

The npm README is copied from the root README by `packages/lector/scripts/prepack.sh`. Keep `README.md` and `packages/lector/README.md` identical; use absolute links so they also work on npm.

## Test in another application with yalc

Use this when you need to reproduce an integration outside the workspace. Install yalc once (`pnpm add --global yalc`), then publish the built package from its directory:

```bash
cd packages/lector
pnpm build
yalc publish
pnpm dev
```

In the consumer application's directory:

```bash
yalc add @anaralabs/lector
```

Run that application's package-manager install and start its dev server. The library's watcher pushes successful builds to registered yalc consumers. To return to the published dependency, run `yalc remove @anaralabs/lector` and reinstall the consumer's dependencies. Review its manifest and lockfile and do not commit incidental `.yalc` or `yalc.lock` files to this repository.

## Open a pull request

Describe the problem, the resulting behavior, and the checks you ran. For rendering changes, include a shareable PDF and before/after images where useful. Test navigation, selection, and zoom if your change affects viewport geometry.

This repository uses conventional commit messages. Documentation commits use the **`doc`** type, for example `doc: improve PDF worker setup`. The allowed types are defined in the root `package.json`; `docs` is not currently in that list.

Keep the PR focused, and mention any validation you could not complete. Do not include private PDFs, credentials, generated build output, or unrelated local changes.
