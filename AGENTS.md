# AGENTS.md

## Cursor Cloud specific instructions

This is a **pnpm monorepo** (Turborepo) for `@anaralabs/lector`, a headless PDF viewer component library for React. No databases, Docker, or external services are required.

### Workspace packages

| Package | Path | Description |
|---|---|---|
| `@anaralabs/lector` | `packages/lector` | Core library (tsup build) |
| `docs` | `packages/docs` | Next.js documentation site with live PDF demos |

Note: `examples/basic` is **not** in the pnpm workspace and depends on the npm-published package, not the local build.

### Key commands

All commands are run from the repo root. See `package.json` scripts and `turbo.json` for the full task graph.

- **Install:** `pnpm install`
- **Build library:** `pnpm build --filter @anaralabs/lector` (must complete before docs can run)
- **Lint:** `pnpm lint` (runs Biome v2 via `biome check .` in each package)
- **Format:** `pnpm format`
- **Dev (docs):** `pnpm dev --filter docs` (Next.js on port 3000)
- **Test:** `pnpm test --filter @anaralabs/lector` (runs both `vitest run` and `size-limit`; no test files currently exist so `vitest` exits 1)

### Build order

Turborepo handles this automatically, but be aware: the library (`@anaralabs/lector`) **must** be built before the docs site can build or start dev mode. When running `pnpm lint`, Turbo also triggers a library build because lint depends on `^build`.

### Gotchas

- The `lector` package `dev` script (`tsup --watch --onSuccess 'yalc push'`) expects `yalc` to be installed globally. This is only needed for local development with an external consumer project, not for running the docs site.
- The `postbuild` script runs `size-limit --json > size.json`; this is normal and produces a `size.json` file in `packages/lector`.
- Husky is configured for commit-msg hooks (commitlint with conventional commits). Commit messages must follow the conventional format, e.g. `feat: ...`, `fix: ...`, `chore: ...`.
- The `docs` package has its own `pnpm-lock.yaml`; this is not used when installing from the monorepo root.
