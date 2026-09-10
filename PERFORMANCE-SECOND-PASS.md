# Performance audit on current main

Base: `675ce1b` (10 September 2026). This report tracks the PR after reconciling the first pass with newer upstream changes.

The PR carries bounded fuzzy search, shared/cancellable text indexing, no-op store guards, memoized page geometry, shared visibility and DPR subscriptions, and document-load lifecycle fixes. It preserves upstream's DPR cap of 3, Safari media-query compatibility, zoom-dependent base rendering, native dark mode and adaptive bitmap budgets. The earlier cache replacement and base-zoom patch are superseded by upstream and are deliberately omitted.

`PERFORMANCE.md` and the first benchmark JSON are historical measurements from the original checkout. Fresh current-main workloads, measurements, and remaining opportunities will be recorded here during the second pass.
