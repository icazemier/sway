---
name: Adaptive Controller
description: Tinker safely on sway's latency-gradient concurrency controller and the scheduler that drives it
---

# Adaptive Controller

Sway's core is a latency-gradient concurrency controller inspired by
[TCP Vegas](https://en.wikipedia.org/wiki/TCP_Vegas) and
[Netflix's adaptive concurrency limiter](https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581).
This skill is for when you are changing that internals — the algorithm, the
scheduler, the invariants — and need the mental model plus the traps that are
easy to reintroduce.

## Files

- `src/adaptive-controller.ts` — the `AdaptiveController` class (the algorithm).
- `src/sway.ts` — the `runSway` scheduler that drives the controller.
- `src/sway-all-settled.ts`, `src/sway-map.ts` — variants built on `runSway`.
- `src/interfaces.ts` — `SwayOptions`, `SwayStats`, `SwayResult`.

## The algorithm, as one mental model

Every `probeInterval` completions, the controller adjusts concurrency:

```
gradient  = minLatency / smoothedLatency(EMA)     // 0..1; 1 = no contention
newLimit  = concurrency × gradient + √concurrency // cautious growth term
concurrency = clamp(round(newLimit), min, max)
```

- **`minLatency`** — learned no-contention baseline (lowest task duration seen).
- **`latencyEma`** — exponential moving average of recent task durations
  (smoothing: `newEma = α·duration + (1−α)·oldEma`, α = `smoothingFactor`, default 0.3).
- **`√concurrency` probe term** — lets concurrency grow even when the gradient
  is neutral (no contention), instead of stalling.

**Why latency, not throughput:** latency is a *leading* indicator — it rises the
moment concurrency overshoots, before throughput visibly drops. Throughput is
lagging. This is the TCP Vegas / Netflix insight. Keep it in mind when judging
"does this change feel right" — a change that looks good on throughput charts
may still be wrong on latency.

## Invariants that must never regress

These are the failure modes the current code deliberately guards against. Tinker
carefully around them:

1. **`gradient` must never be `NaN`.** Both `minLatency` and the EMA can be 0
   (a task measured as 0ms), giving `0/0 = NaN`. The guard is
   `gradient = emaLat > 0 ? minLat / emaLat : 1`. NaN fails every comparison,
   survives clamping, and permanently closes the scheduler's concurrency gate.
   **Never "simplify" this ternary.**

2. **`clamp` must treat `NaN` as "keep current", not clamp-to-bound.**
   `Math.max`/`Math.min` propagate NaN rather than clamping it, so
   `clamp()` explicitly returns `this.concurrency` when `NaN` arrives. Without
   this, a non-numeric limit reaches the scheduler and stalls it.

3. **`minLatency` decays toward the EMA**, not a permanent floor:
   `minLatency = minLat + (emaLat − minLat) * 0.05`. The `0.05` prevents a single
   anomalously-fast task from poisoning the gradient forever. Do not "fix" it to
   a constant floor without understanding why it exists.

4. **Bounds are validated at the edge.** `requirePositiveInteger` and
   `requireRatio` reject bad options at construction (`minConcurrency ≤
   maxConcurrency` also enforced). Values crossing a JS boundary or an `any` can
   otherwise silently corrupt every later calculation. Keep validation at the
   constructor edge, where the caller sees the error.

5. **Stats stay honest.** `peakConcurrency`, `avgConcurrency` (weighted by
   concurrency samples), and `adjustments` must reflect actual scheduling. A
   telemetry change should not silently lie about behavior.

## The scheduler (`runSway`)

- Pulls tasks lazily from the iterable while `activeTasks <
  controller.getConcurrency()`.
- Fail-fast: rejects on the first error; remaining in-flight tasks are not
  cancelled (promises aren't cancellable) — no new tasks are started.
- `shouldRecord(value)` decides whether a settled task's latency feeds the
  controller. `sway.allSettled` uses this to keep pre-flight-rejection latencies
  (which don't reflect real backend cost) out of the learned baseline.
- Order of `results` matches input order regardless of completion order.

## When you change the controller

1. Run the verify chain: `npm run lint`, `npm run build`, `npm test`.
2. Re-run the benchmark (`npm run benchmark`) and update the README tables if
   results shift — see the `benchmarking` skill.
3. Check the 100%-failure caveat still holds: with no successful-task latency,
   the controller stays at `initialConcurrency`. That is expected, not a bug.
4. Do **not** touch `src/*.bench.ts` — they're sacred (see `security-updates` /
   `benchmarking` skills).

## Netflix grounding

Sway's controller is the JS descendant of Netflix's `GradientLimit` (the
`√concurrency` term comes straight from its `SquareRootFunction` queue size).
The reference file maps every term to its Netflix original and notes the
deliberate simplifications. Ground yourself there before changing the update
rule.

- Netflix `concurrency-limits` repo: https://github.com/Netflix/concurrency-limits
- `GradientLimit.java` — the algorithm sway's is modeled on.
- Netflix blog post: https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581
  (GitHub README is the reliable source; Medium may 403).

## References

- `references/algorithm.md` — the full derivation, rationale, and Netflix mapping.
- `src/adaptive-controller.ts`, `src/sway.ts`, `src/interfaces.ts` — the code.
- `README.md` `## How it works` and `## Advanced: AdaptiveController`.
- The `benchmarking` skill — how the controller's ~1.2x claim is validated.
