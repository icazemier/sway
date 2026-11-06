---
name: Adaptive Controller
description: Tinker safely on sway's latency-based (VegasLimit-style) concurrency controller and the scheduler that drives it
---

# Adaptive Controller

Sway's core is a **latency-based adaptive concurrency controller** rebuilt
faithful to [Netflix's `VegasLimit`](https://github.com/Netflix/concurrency-limits)
(TCP Vegas lineage). This skill is for when you change those internals — the
algorithm, the scheduler, the invariants — and need the mental model plus the
traps that are easy to reintroduce.

> The controller was rebuilt from the old gradient model (PR #53). Any docs or
> notes describing `minLatency` decay, a `√concurrency` term, or `GradientLimit`
> are **stale** — do not resurrect them.

## Files

- `src/adaptive-controller.ts` — the `AdaptiveController` class (the algorithm).
- `src/sway.ts` — the `runSway` scheduler that drives the controller.
- `src/sway-all-settled.ts`, `src/sway-map.ts` — variants built on `runSway`.
- `src/interfaces.ts` — `SwayOptions`, `SwayStats`, `SwayResult`.
- `src/queuing-sim.ts` — deterministic queuing-resource simulator used **only by
  the specs**. It is excluded from the build tsconfigs and from `jsr.json`, so it
  never ships in the published package.

## The algorithm, as one mental model

Every `probeInterval` (default **8**) completions, the controller estimates how
many tasks are queued behind a full slot and adjusts the integer limit:

```
queueSize = ceil(concurrency × (1 − minLatency / latencyEma))   // estimated queue
// proportional decision bands (Netflix's documented intent):
//   queueSize ≤ 5%·limit   → aggressive increase (+max(1, beta))
//   queueSize < 10%·limit  → slow increase (+log10Root(limit))  — only reachable
//                            when 10%−5% of the limit spans a whole integer
//   queueSize > 10%·limit  → decrease (−log10Root(limit))
//   in between             → hold (sweet spot)
concurrency = clamp(newLimit, minConcurrency, maxConcurrency)   // decisive integer step
```

- **`minLatency`** — recoverable no-load baseline: the **P25 of a rolling
  64-sample window** of recent latencies. Exact on deterministic resources (no
  jitter → percentile == floor), recovers after overshoot spikes on jittery ones.
- **`latencyEma`** — EMA of recent task durations
  (`newEma = α·duration + (1−α)·oldEma`, α = `smoothingFactor`, default 0.3).
- **`MIN_QUEUING_RATIO = 1.15`** — jitter dead-zone: latency inflation up to
  1.15× the no-load floor is measurement noise, not queuing (`queueSize = 0`).
  A ratio past it counts as queuing even when the size bands don't fire.
- **`settled` hysteresis** — once the sweet spot is found, the controller stops
  probing up until the next re-probe refreshes the baseline (prevents oscillation
  one step above the optimum).
- **Re-probe** — `probeCount` increments on **every completion**; after roughly
  `jitter × probeMultiplier × concurrency` completions (jitter ∈ [0.5, 1],
  `probeMultiplier` default 30) the baseline is refreshed so capacity growth is
  detected.

**Why latency, not throughput:** latency is a *leading* indicator — it rises the
moment concurrency overshoots, before throughput visibly drops. Throughput is
lagging. Judge changes on latency, not throughput charts.

## Invariants that must never regress

1. **The anti-drift guard must let a controller at the minimum grow.** The guard
   holds when `inflight * 2 < concurrency`. `inflight` must count the
   **completing task** (Netflix `getActiveCount()`): `sway.ts` passes
   `activeTasks + 1`, never bare `activeTasks`. At concurrency 1, bare
   `activeTasks` is 0 after decrement, `0*2 < 1` always holds, and the
   controller gets **stuck at 1** (regression test:
   `grows from the minimum when started at initialConcurrency=1`).
2. **`probeCount` counts completions, not probes.** Incrementing it inside
   `probe()` makes re-probes `probeInterval`× rarer than documented.
3. **Limit adjustments are decisive integer steps.** Smoothing a `+1` through an
   integer limit erases it after rounding (`4 → 0.7·4+0.3·5 = 4.3 → round 4`),
   which is why the old controller never ramped. Apply the integer step directly.
4. **Bounds are validated at the edge.** `requirePositiveInteger` /
   `requireRatio` reject bad options at construction (`minConcurrency ≤
   maxConcurrency` also enforced). Keep validation at the constructor edge.
5. **Stats stay honest.** `peakConcurrency`, `avgConcurrency`, `adjustments`
   must reflect actual scheduling.

## The scheduler (`runSway`)

- Pulls tasks lazily from the iterable while `activeTasks < controller.getConcurrency()`.
- Fail-fast: rejects on the first error; in-flight tasks are not cancelled — no
  new tasks are started.
- `shouldRecord(value)` decides whether a settled task's latency feeds the
  controller (`sway.allSettled` keeps pre-flight-rejection latencies out of the
  baseline).
- `results` order matches input order regardless of completion order.

## When you change the controller

1. Verify chain: `npm run lint` → `npm run build` → `npm test` → `npm run smoke`.
2. Re-run `npm run benchmark` if behavior shifts — see the `benchmarking` skill.
3. Add/adjust specs in `src/adaptive-controller.spec.ts` (33 tests, incl.
   deterministic capacity-1/4 queuing scenarios via `runQueuingSim`).

## Netflix grounding

- Netflix `concurrency-limits` repo: https://github.com/Netflix/concurrency-limits
  (`VegasLimit.java` is the direct model).
- Netflix blog: https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581
  (GitHub README is the reliable source; Medium may 403).

## References

- `references/algorithm.md` — full derivation, rationale, and Netflix mapping.
- `src/adaptive-controller.ts`, `src/sway.ts`, `src/interfaces.ts` — the code.
- `README.md` `## How it works`.
- The `benchmarking` skill — how the performance claims are validated.
