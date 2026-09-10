# Lector performance audit

The completed two-pass audit, measurements against current main, API examples,
validation and remaining opportunities are in [PERFORMANCE-SECOND-PASS.md](PERFORMANCE-SECOND-PASS.md).

Raw current-main measurements: [current-main-results-2026-09-10.json](packages/lector/benchmarks/current-main-results-2026-09-10.json).

The earlier [results-2026-09-10.json](packages/lector/benchmarks/results-2026-09-10.json)
records historical measurements from checkout `29f89b2`. That checkout predated
upstream's adaptive bitmap budgets and Safari/base-canvas changes. The PR is based
on `675ce1b`, preserves those upstream improvements, and does not claim them as
changes introduced here.

The follow-up after PR #159 is documented in [READER-QUALITY.md](READER-QUALITY.md),
including incremental annotation measurements, Unicode search fixes, reader
interaction checks and the next prioritized engineering investigations.
