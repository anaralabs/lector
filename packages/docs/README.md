# docs

This is a Next.js application generated with
[Create Fumadocs](https://github.com/fuma-nama/fumadocs).

Run development server:

```bash
npm run dev
# or
pnpm dev
# or
yarn dev
```

Open http://localhost:3000 with your browser to see the result.

## pdfjs-dist webpack patch

The file `lib/pdfjs-webpack-patch.cjs` is a tiny webpack loader that works around
an upstream bug ([webpack/webpack#20095](https://github.com/webpack/webpack/issues/20095))
affecting `pdfjs-dist` in Next.js dev mode.

**The problem:** `pdfjs-dist/build/pdf.mjs` is itself a webpack bundle and declares
`var __webpack_exports__ = {};` internally. When Next.js's dev server wraps modules
in `eval()` for source maps, this variable shadows webpack's own `__webpack_exports__`
parameter, causing `Object.defineProperty called on non-object` at runtime.

**The fix:** The loader adds a no-op reference (`__webpack_exports__;`) after the
declaration, which makes webpack's scope analysis recognise the conflict and rename
the inner variable automatically. This is the same approach used in the upstream
webpack fix ([webpack/webpack#20097](https://github.com/webpack/webpack/pull/20097)).

**When to remove:** Once Next.js ships with webpack >= 5.103.0 (tracked in
[vercel/next.js#89569](https://github.com/vercel/next.js/pull/89569)), this loader
and the corresponding rule in `next.config.mjs` can be deleted.

## Learn More

To learn more about Next.js and Fumadocs, take a look at the following
resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js
  features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [Fumadocs](https://fumadocs.vercel.app) - learn about Fumadocs
