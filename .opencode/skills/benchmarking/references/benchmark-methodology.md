# Benchmark methodology

Deep reference for sway's benchmarks. Explains the resource model and how the
README tables are derived, so results can be reproduced and kept honest.

## Resource model

Both benches simulate a downstream resource with an optimal concurrency of
**8**. The resource applies back-pressure the way a real database or API does:
raising latency as more than 8 tasks run concurrently, with a hard contention
ceiling. The model is inspired by
[Netflix's concurrency-limits](https://github.com/Netflix/concurrency-limits).

Two scenarios:

1. **Fixed contention** — optimal concurrency stays at 8 for the whole run.
2. **Shifting capacity** — the resource's sweet spot drops from 8 to 4 mid-run,
   so a static fixed pool is wrong at one end of the run.

## Task count

500 tasks per run. This is large enough for the controller to learn (it needs
~20 to be useful, and a few probe windows to converge) but small enough to run
fast in CI/dev.

## Baselines compared

- `fixed pool (c=8)` — the optimal fixed choice for the contention resource.
- `fixed pool (c=32)` / `c=64` — too high; show the cost of overshooting.
- `Promise.allSettled` (in the settled bench) — unbounded parallelism.

## How the ratios are computed

Every table row reports time **relative to the best approach in that scenario**
(`1.0x`), with sway's number shown against it. The ~1.2x figure is sway's
overhead — the cost of the learning phase. A wrong fixed guess is the 
counterpoint: 8–50x worse depending on how wrong.

## The settled bench

`sway-all-settled.bench.ts` uses 500 tasks at the same contention resource with
a fraction failing fast (~1ms pre-flight rejections):

| Failure rate | Interpretation |
| ------------ | -------------- |
| 10% (flaky)      | Mostly success; sway adapts normally |
| 50% (very flaky) | Half fail; controller still learns from successes |
| 100% (fully cooked) | No successes → no latency signal; controller stays at `initialConcurrency` |

## Reproducing

```bash
npm run benchmark
```

The README numbers must always match a fresh run. If they drift, re-run and
update the tables — never invent figures.

## Why latency, not throughput

The controller uses latency as a *leading* indicator: it rises the moment
concurrency exceeds the sweet spot, before throughput visibly drops. Throughput
is a lagging indicator and only falls after back-pressure piles up. This is the
TCP Vegas / Netflix insight the README cites.
