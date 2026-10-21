# Proposal: throughput gate

## Problem

Sway only measures latency. When a resource **queues** work instead of slowing down (a server that handles one request at a time, a fixed pool of slots), sway keeps raising concurrency even though nothing gets faster.

Why:

- Every probe: `gradient = minLatency / latencyEma`, then `newLimit = concurrency × gradient + √concurrency`.
- After every probe, `minLatency` moves 5% toward the EMA.
- With a queue, the extra latency is steady, so the baseline catches up, `gradient` goes to ~1, and every probe adds `√concurrency`.

Only `maxConcurrency` stops it.

## Evidence

Simulated with the existing `createQueuingResource` and `createContentionResource` from `src/bench-resources.ts` (sway 2.2.0):

| Resource | sway (defaults) | Fixed pool at the optimum |
|---|---|---|
| Queue, capacity 1, 600 tasks | 95/s, **peak 15**, avg 7.5 | 95/s, 1 |
| Queue, capacity 4, 1200 tasks | 403/s, **peak 27**, avg 14.6 | 407/s, 4 |
| Contention, optimal 8, 500 tasks | 624/s, peak 14, avg 9.6 | 726/s, 8 |

Same throughput, but sway runs 4–15× more tasks at once than needed, so each task waits longer in the queue.

In practice (dad-photo-tagger, vision LLM on a server handling one request at a time): throughput stayed at 0.38–0.41 photos/s while sway went from 2 to its cap of 8, and the time per request grew from ~8 s to ~19 s. Without the cap, sway could reach its default of 64, where each request waits ~64 × 2.7 s ≈ 173 s, right at the client's 180 s timeout.

## Idea

Only keep a concurrency increase if throughput actually went up.

1. Measure throughput per probe window: `completions / window wall-clock time`.
2. When a probe **raises** concurrency, remember the level and throughput from before the increase.
3. At the next probe, compare:
   - throughput rose by at least ~5%: keep the new level.
   - otherwise: go back to the previous level, and don't try raising again for a few probes.
4. After that pause, allow one new try, so sway still notices when capacity grows.
5. Decreases from the latency gradient stay as they are.

## API

- `recordCompletion(durationMs, completedAt = performance.now())`: the optional timestamp keeps tests deterministic and the change non-breaking.
- Possibly new options: `minThroughputGain` (default `0.05`), `retryAfterProbes` (default e.g. `8`).

## To check

- Throughput per window is noisy with small `probeInterval`; the threshold must not cause false reverts.
- Add a benchmark: queuing resource with capacity 1 and 4, peak/avg concurrency next to the fixed pool.
- Existing benchmarks (contention 8/4, shifting capacity) must not get slower.
