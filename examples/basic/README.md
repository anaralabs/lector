# Basic Lector example

A standalone Vite app with canvas rendering, selectable text, and a light/dark toggle. It uses the **published** `@anaralabs/lector` package by default, not the local workspace source.

[Open in StackBlitz](https://stackblitz.com/github/anaralabs/lector/tree/main/examples/basic)

## Run locally

Use Node.js 22.13+ and pnpm 9.5.0. From this directory:

```bash
pnpm install
pnpm dev
```

Open the local URL printed by Vite (normally [localhost:5173](http://localhost:5173)). This directory is outside the root pnpm workspace, so install its dependencies separately.

`src/App.tsx` configures the matching legacy PDF.js worker and renders `/sample.pdf`. Replace `public/sample.pdf` to try another document. The dark-mode toggle passes `colorScheme` to `Root` and styles the surrounding app separately.

## Build and preview

```bash
pnpm build
pnpm preview
```

Open the preview URL printed by Vite and verify that the PDF and worker load there too.

## Test local library changes

For the shortest development loop, use the docs app, which already links the workspace library. To test a change in this standalone app, follow the [yalc instructions](../../CONTRIBUTING.md#test-in-another-application-with-yalc).

See [installation](https://lector-weld.vercel.app/docs/installation) for worker alternatives and Next.js setup, or [the API reference](https://lector-weld.vercel.app/docs/api) for component and hook contracts.
