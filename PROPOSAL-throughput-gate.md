# Superseded: throughput gate → Netflix VegasLimit rebuild

> **Status: superseded.** This proposal described a throughput gate that was
> tried on the `beaef9c` commit, measured, and **rejected** in favour of
> rebuilding the controller faithfully to Netflix's `VegasLimit`. The rebuild
> is implemented in `src/adaptive-controller.ts`; this document is kept only as
> a record of why the gate approach was abandoned.

## Original problem (still the motivation)

Sway only measured latency. When a resource **queues** work instead of slowing down (a
server that handles one request at a time, a fixed pool of slots), the old gradient
controller kept raising concurrency even though nothing got faster:

- Every probe: `gradient = minLatency / latencyEma`, then `newLimit = concurrency × gradient + √concurrency`.
- After every probe, `minLatency` moved 5% toward the EMA.
- With a queue, the extra latency is steady, so the baseline caught up, `gradient` went
  to ~1, and every probe added `√concurrency` with nothing to cancel it.
- Only `maxConcurrency` stopped it.

Measured baseline (true `origin/development`):

| Resource | sway (defaults) | Fixed pool at the optimum |
|---|---|---|
| Queue, capacity 1 | peak 7-10 vs optimum 1 | ~5-10× slower |
| Queue, capacity 4 | peak 5-6 vs 4 | wall-clock flat (benchmark blind spot) |
| Contention, optimal 8 | peak 6, avg 2.3-3.4 vs 8 | under-utilises, 3-5× slower |

Root cause confirmed by a deterministic trace: the 5% `minLatency` decay erased the
no-load baseline on queuing resources → gradient pinned at 1.000 → unconditional
`+√concurrency` oscillated 4→6→4→6 forever on capacity 1.

## Why the throughput gate failed

The gate (add `minThroughputGain`, `retryAfterProbes`) was built on top of the same
broken latency-gradient foundation. On a queuing resource throughput is capped at
`capacity / serviceTime` regardless of concurrency, so the gate's throughput signal was
flat/noise-dominated and could not reliably detect overshoot. Fixing the controller's
latency model — not adding a second, equally blind signal — was the correct move.

## Chosen approach: faithful Netflix `VegasLimit` rebuild

Rebuilt `AdaptiveController` to mirror Netflix's `VegasLimit`:

1. **Stable no-load baseline** — `minLatency` is only lowered by a faster sample or
   refreshed by a periodic re-probe; it never decays toward the EMA.
2. **Queue estimation** — `queueSize = ceil(concurrency × (1 − minLatency / latencyEma))`.
3. **Proportional bands** (Netflix documented intent) with floors so any queuing at tiny
   limits triggers a decrease:

   ```
   threshold = max(0, round(0.05 × limit))
   alpha     = max(1, round(0.10 × limit))
   beta      = max(0, round(0.20 × limit))   // 0-floor: queueSize ≥ 1 at limits 1-4 decreases
   step      = max(1, floor(log10(limit)))   // Log10RootIntFunction
   ```

4. **Periodic re-probe** — every ~`jitter × probeMultiplier × concurrency` completions,
   refresh `minLatency = latencyEma` and hold, so capacity growth is detected and the
   controller does not get stuck too low.

The gate's options (`minThroughputGain`, `retryAfterProbes`) are **removed** from the
public API. `probeMultiplier` (default 30) is added.

## Verification

- Deterministic queuing simulator (`src/queuing-sim.ts`) reproduces capacity-1 and
  capacity-4 overshoot bit-for-bit and asserts the controller holds near the optimum.
- `src/sway.bench.ts` logs measured peak/avg concurrency next to the fixed-pool optimum
  for queuing capacity-1, capacity-4, and capacity-8 groups.
- Old (`origin/development`) vs new on the deterministic sim.

## Files changed

- `src/adaptive-controller.ts` — rebuilt controller.
- `src/interfaces.ts` — removed gate options, added `probeMultiplier`.
- `src/adaptive-controller.spec.ts` — updated to the new model + overshoot tests.
- `src/sway.bench.ts` — queuing capacity-1/4 groups with peak/avg reporting.
- `src/queuing-sim.ts` — deterministic simulator (new).
