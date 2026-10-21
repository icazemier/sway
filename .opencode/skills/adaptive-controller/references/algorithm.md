# Adaptive controller algorithm

Deep reference for sway's latency-gradient controller. Records the reasoning
behind each term and guard so a future contributor can tinker without breaking
the equilibrium.

## Lineage

The design comes from two sources:

- **TCP Vegas** — uses latency *differences* to detect congestion before loss,
  rather than reacting to dropped packets (the leading-indicator idea).
- **Netflix's concurrency-limits** — limits in-flight requests by comparing a
  no-contention latency baseline to current latency, adapting to backend
  capacity without knowing it in advance.

Sway's controller is the direct JS descendant of Netflix's **`GradientLimit`**
(`com.netflix.concurrency.limits.limit.GradientLimit`), with a simplified
update rule. Netflix's own update step, for comparison:

```java
gradient = max(0.5, min(1.0, rttTolerance * rttNoLoad / rtt));
newLimit = estimatedLimit * gradient + queueSize;   // queueSize ≈ √limit by default
newLimit = max(queueSize, min(maxLimit, newLimit));
if (newLimit < estimatedLimit) {
    newLimit = max(minLimit, estimatedLimit*(1-smoothing) + smoothing*newLimit);
}
```

The `queueSize` defaults to `SquareRootFunction.create(4)` — i.e. `√limit`,
which is exactly where sway's `+ √concurrency` term comes from. Netflix's README
explains the rationale: *"better than a fixed queue size that becomes too small
for large limits but still prevents the limit from growing too much by slowing
down growth as the limit grows."*

## How sway maps to Netflix's GradientLimit

| Netflix `GradientLimit` | Sway `AdaptiveController` |
| --- | --- |
| `rttNoLoad` (minimum RTT measurement) | `minLatency` (learned no-contention baseline) |
| `rtt` (current sample) | `latencyEma` (smoothed current latency) |
| `gradient = rttTolerance * rttNoLoad / rtt` | `gradient = minLatency / latencyEma` |
| `queueSize ≈ √limit` | `+ √concurrency` |
| `minLimit` / `maxLimit` | `minConcurrency` / `maxConcurrency` |
| `smoothing` (default 0.2) | `smoothingFactor` (default 0.3) |
| periodic RTT probe/reset | `minLatency` decay toward EMA (the 5% term) |

Key deliberate simplifications in sway:

- Netflix clamps the gradient to a floor of `0.5` (so a limit is never reduced
  by more than half per step) and scales by `rttTolerance` (default 2.0, meaning
  a 2× latency rise is tolerated before reducing). Sway does **not** clamp the
  gradient to `0.5` — it lets it fall further under heavy contention (10× latency
  → gradient ~0.1), trading Netflix's conservatism for sharper load-shedding.
- Netflix reduces the limit *aggressively* on a dropped/timeout request
  (`backoffRatio`) and refuses to grow when app-limited. Sway has no timeout
  signal, so it never back-offs on drops — it only reacts through latency.
- Netflix applies its `smoothing` when the new limit **shrinks**; sway's
  `smoothingFactor` is baked into the EMA of latencies instead, not the limit.

These differences are deliberate; when tinkering, treat them as features, not
bugs.

## Why latency over throughput

Throughput (tasks/sec) is a *lagging* indicator: it only drops *after* you have
already overshot, by which point back-pressure has piled up. Latency is
*leading*: it rises immediately when concurrency exceeds the sweet spot, because
tasks start queueing before throughput visibly falls. A controller that reacts
to latency catches contention early instead of chasing it.

## Terms in the update rule

```
newLimit = concurrency × gradient + √concurrency
```

| Term | Meaning | Why |
| ---- | ------- | --- |
| `gradient = minLatency / latencyEma` | Ratio of no-contention baseline to current latency. ≈1 = no contention; ~0.5 = 2× baseline (moderate); ~0.1 = 10× baseline (heavy). | Multiplicatively scales concurrency toward equilibrium. |
| `concurrency × gradient` | The equilibrium-seeking component. | Scales the current level down under contention, holds it steady at baseline. |
| `√concurrency` | Cautious growth term. | Lets concurrency grow even at neutral gradient (gradient ≈ 1), so the controller never stalls. The square root gives diminishing marginal growth. |

## The EMA smoothing

```
newEma = α·duration + (1−α)·oldEma
```

`α = smoothingFactor`, default `0.3`. Lower α = calmer adjustments (more
historical weight); higher = more responsive but noisier. This is the
exponential moving average of recent task durations.

## The learned baseline and its decay

`minLatency` starts as the first observed duration and is updated to any faster
task. **Critically, it is not a permanent floor:**

```
minLatency = minLat + (emaLat − minLat) × 0.05
```

After each probe, the baseline decays 5% toward the EMA. This prevents a single
anomalously-fast early task from permanently skewing the gradient; genuinely
fast tasks keep refreshing the baseline. Removing the decay would make the
controller permanently pessimistic about a transient fast sample.

## Edge cases the code defends against

### 0/0 → NaN gradient

If both `minLatency` and the EMA measure 0 (a task completing in 0ms), the naive
`minLat / emaLat` is `NaN`. `NaN` fails every comparison, so it would survive
clamping and permanently close the scheduler's concurrency gate. The code guards:

```
gradient = emaLat > 0 ? minLat / emaLat : 1
```

No measurable latency means no contention → neutral gradient (1), and the limit
still grows by the probe term.

### NaN through clamp

`Math.max`/`Math.min` propagate `NaN` rather than clamping it. `clamp()` must
therefore return the current concurrency when given `NaN`:

```
if (Number.isNaN(value)) return this.concurrency;
return Math.max(min, Math.min(max, value));
```

Infinities clamp to the bounds normally; only NaN is special.

### Input validation at the edge

Options are validated at construction (`requirePositiveInteger`,
`requireRatio`), because a value crossing a JS boundary, a parsed config, or an
`any` in consumer code reaches the controller unchecked. A non-finite or
fractional bound silently corrupts every later calculation, so it is rejected
where the caller can still see which option was wrong.

## The 100%-failure regime

When every task fails fast, the controller never receives a successful-task
latency to learn from, so it stays at `initialConcurrency` (default 4). This is
expected and documented in the README — cheap in absolute terms, but not where
adaptive concurrency shines. For a workload that fails ~100% of the time,
`Promise.allSettled` directly is the right tool.

## Telemetry

- `peakConcurrency` — highest concurrency reached.
- `avgConcurrency` — weighted average over concurrency samples (not wall-clock),
  giving a fair mean across varying levels.
- `adjustments` — count of times the level actually changed.

These must stay honest; they are the contract `SwayStats` exposes to consumers.

## Tinkering checklist

When changing the algorithm, preserve:

1. The `NaN` gradient guard.
2. The `NaN`-returns-current clamp.
3. The baseline decay toward the EMA.
4. Edge validation + `min ≤ initial ≤ max`.
5. Honest telemetry.

Then verify: `npm run lint`, `npm run build`, `npm test`, and `npm run
benchmark` (update README tables if numbers shift).
