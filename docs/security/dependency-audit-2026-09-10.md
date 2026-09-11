# lector: dependency security coverage, 2026-09-10

Inventory: all 19 open Dependabot alerts on the default branch, at every severity. Base commit: `67c08235b20ad671874cc994a2899241124506e0`.

Version fixes below require merge into the default branch before Dependabot closes the alerts. Deploy the affected applications before treating running services as remediated. Dismissals are limited to the documented unreachable extraction paths.

| Alert | Severity | Package / manifest | Resolution |
| --- | --- | --- | --- |
| [#310](https://github.com/anaralabs/lector/security/dependabot/310) | low | `postcss-selector-parser` in `pnpm-lock.yaml` | This PR: `6.1.4`, `7.0.0` |
| [#311](https://github.com/anaralabs/lector/security/dependabot/311) | low | `postcss-selector-parser` in `examples/basic/pnpm-lock.yaml` | This PR: `6.1.4` |
| [#312](https://github.com/anaralabs/lector/security/dependabot/312) | high | `fast-uri` in `pnpm-lock.yaml` | This PR: `3.1.6` |
| [#313](https://github.com/anaralabs/lector/security/dependabot/313) | high | `fast-uri` in `pnpm-lock.yaml` | This PR: `3.1.6` |
| [#314](https://github.com/anaralabs/lector/security/dependabot/314) | high | `fast-uri` in `pnpm-lock.yaml` | This PR: `3.1.6` |
| [#315](https://github.com/anaralabs/lector/security/dependabot/315) | high | `fast-uri` in `pnpm-lock.yaml` | This PR: `3.1.6` |
| [#316](https://github.com/anaralabs/lector/security/dependabot/316) | high | `browserslist` in `pnpm-lock.yaml` | This PR: `4.28.9` |
| [#318](https://github.com/anaralabs/lector/security/dependabot/318) | high | `browserslist` in `pnpm-lock.yaml` | This PR: `4.28.9` |
| [#319](https://github.com/anaralabs/lector/security/dependabot/319) | high | `browserslist` in `examples/basic/pnpm-lock.yaml` | This PR: `4.28.9` |
| [#320](https://github.com/anaralabs/lector/security/dependabot/320) | high | `extract-zip` in `pnpm-lock.yaml` | This PR: removed unused WebdriverIO dependency and its vulnerable subtree |
| [#321](https://github.com/anaralabs/lector/security/dependabot/321) | medium | `@vitest/mocker` in `pnpm-lock.yaml` | This PR: `4.1.11` |
| [#322](https://github.com/anaralabs/lector/security/dependabot/322) | medium | `baseline-browser-mapping` in `examples/basic/pnpm-lock.yaml` | This PR: `2.11.21` |
| [#323](https://github.com/anaralabs/lector/security/dependabot/323) | medium | `vitest` in `packages/lector/package.json` | This PR: `4.1.11` |
| [#324](https://github.com/anaralabs/lector/security/dependabot/324) | medium | `vitest` in `pnpm-lock.yaml` | This PR: `4.1.11` |
| [#325](https://github.com/anaralabs/lector/security/dependabot/325) | critical | `next` in `pnpm-lock.yaml` | This PR: `15.5.25` |
| [#326](https://github.com/anaralabs/lector/security/dependabot/326) | critical | `next` in `pnpm-lock.yaml` | This PR: `15.5.25` |
| [#327](https://github.com/anaralabs/lector/security/dependabot/327) | high | `js-yaml` in `pnpm-lock.yaml` | This PR: `3.15.2`, `4.3.2` |
| [#328](https://github.com/anaralabs/lector/security/dependabot/328) | high | `js-yaml` in `pnpm-lock.yaml` | This PR: `3.15.2`, `4.3.2` |
| [#329](https://github.com/anaralabs/lector/security/dependabot/329) | high | `sharp` in `pnpm-lock.yaml` | This PR: `0.35.4` |

## Independent lockfile audits

| Lockfile | Result |
| --- | --- |
| `pnpm-lock.yaml` | npm advisory occurrences reduced from 53 to 2; zero critical or moderate. Both remaining findings concern build-only image-size. |
| `examples/basic/pnpm-lock.yaml` | Zero advisories after independent updates. |

## Remaining advisory evidence

`image-size` GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq were already dismissed as #301/#302. The sole remaining consumer is `fumadocs-core@14.6.2`, in `dist/mdx-plugins/index.js`: it measures documentation images during MDX compilation. The repository authors those files; application users cannot supply images to this build path. The published Lector library does not depend on image-size. No patched upstream version exists. This PR also raises the 1.x copy to 1.2.1 to fix the separate patched advisory. Reassess if untrusted MDX/image compilation is introduced.

## Additional fixes from the full audit

Removed unused `webdriverio`, which eliminated extract-zip, deepmerge-ts, tar-fs, basic-ftp and the legacy driver XML parser. Updated Next.js within 15.5, Sharp, Vitest/Playwright and transitive esbuild, glob, minimatch, Rollup, image-size and the separate example dependencies. Vitest 4 requires its explicit Playwright provider, the new browser import and constructible observer mocks.

## Verification

- Frozen lockfile installation.
- After merging main at `922db12`: eight unit tests, 156 Chromium browser tests and library typecheck passed. Browser tests exercised the custom Chromium executable path through the Vitest 4 Playwright provider.
- Library bundle/types and Next.js documentation production build.
- Packed ESM exports, CommonJS diagnostic and server-rendering checks.
- Six documentation agent tests passed.
- Analytics coverage: dependency/build/test-only changes; no new event needed.

GitHub returned no code-scanning analysis and secret scanning is disabled. This inventory covers dependency advisories rather than arbitrary application or container vulnerabilities.
