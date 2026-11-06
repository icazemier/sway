# Adaptive controller — algorithm reference (VegasLimit rebuild)

This document is the derivation and rationale behind `src/adaptive-controller.ts`
after the VegasLimit rebuild (PR #53). It maps every term to its Netflix
`concurrency-limits` original and notes deliberate deviations.

## Core estimate

```ts
queueSize = ceil(concurrency × (1 − minLatency / latencyEma))
```

- Netflix `VegasLimit`: `expected = limit × rttNoLoad / rttLoad`;
  `queueSize = limit − expected`. Same shape: `limit × (1 − min/ema)`.
- `latencyEma` — EMA of task durations, `α = smoothingFactor` (default 0.3).
  Netflix `VegasLimit` uses a similar RTT EMA.
- `minLatency` — **P25 of a rolling 64-sample window**, re-anchored once the
  window is warm. Netflix uses a strict monotonic `rttNoLoad`. Deliberate
  deviation: a strict floor clings to the low tail of a jitter distribution and
  spirals the limit to 1 on contended resources (the collapse-to-1 regression
  the rebuild fixed). The low percentile stays exact when there is no jitter
  but recovers after an overshoot spike.

## Jitter dead-zone

`MIN_QUEUING_RATIO = 1.15`. On a noisy-but-healthy resource the EMA sits a few
percent above the floor (additive jitter ≥ base service time), so `emaLat/minLat`
≈ 1.1 is noise, not queuing. Inflation ≤ 1.15× is treated as `queueSize = 0`;
past it, `hasQueuing` is true even when the size bands don't fire — so one queued
task at a tiny limit still triggers a decrease.

## Decision bands (proportional, Netflix's documented intent)

| `queueSize` vs limit | Action |
|---|---|
| `≤ round(5%·limit)` | aggressive increase: `+max(1, beta)` |
| `< max(1, round(10%·limit))` and not queuing | slow increase: `+log10Root(limit)` |
| `> max(1, floor(10%·limit))` | decrease: `−log10Root(limit)` |
| in between | hold |

- `beta` is floored at 1 so `queueSize = 1` is always caught by `hasQueuing`.
- Netflix: `alpha = max(1, round(0.1·limit))`, `beta = max(1, floor(0.1·limit))`,
  `threshold = round(0.05·limit)`. Same here.
- The "mild queuing" band only exists when `10% − 5%` of the limit spans a whole
  integer (e.g. limit ≥ 25); below that the controller jumps straight from
  aggressive increase to decrease.
- `step = log10Root(limit)` — Netflix's `log10` step function.

## Hysteresis (`settled`)

Netflix's VegasLimit oscillates one step above the optimum because latency jitter
with `queueSize = 0` triggers `+beta` on every probe. Once the controller finds
the sweet spot (`settled = true`), it stops **all** probing up until the next
re-probe. Deviation is deliberate: we settle instead of oscillating.

## Decisive integer steps

The limit is an integer; the adjustment is applied as-is, not smoothed through an
EMA. Smoothing a `+1` move (`4 → 0.7·4 + 0.3·5 = 4.3 → round 4`) erases it — the
old gradient model never ramped for exactly this reason.

## Re-probe

- `probeCount++` on **every** `recordCompletion` (Netflix increments per RTT
  sample). Do not move it into `probe()` — that makes re-probes
  `probeInterval`× rarer than documented.
- Re-probe fires when `probeJitter × probeMultiplier × concurrency ≤ probeCount`
  (`probeJitter` re-drawn ∈ [0.5, 1] after each re-probe; `probeMultiplier`
  default 30). It refreshes the baseline to the current EMA and holds the limit,
  so capacity growth is detected.

## Anti-drift guard

```ts
if (inflight * 2 < concurrency) return;  // hold — not enough real load to fill the limit
```

`inflight` must count the completing task (Netflix `getActiveCount()`); `sway.ts`
passes `activeTasks + 1`. At concurrency 1, excluding the completing task gives
`inflight = 0`, the guard holds forever, and the controller is stuck at 1.

## Scheduler notes (`src/sway.ts`)

- Lazy pull while `activeTasks < getConcurrency()`; fail-fast reject on first
  error; results in input order.
- `recordCompletion(completedAt − taskStart, activeTasks + 1, /* didDrop */ false)`.
- `didDrop = true` (timeout/drop) forces a decisive decrease regardless of
  measured queue size.

## Netflix mapping

| sway term | Netflix `VegasLimit` |
|---|---|
| `queueSize = ceil(limit × (1 − min/ema))` | `limit − limit × rttNoLoad / rttLoad` |
| P25 rolling-window `minLatency` | strict `rttNoLoad` (deviation: recoverable) |
| `MIN_QUEUING_RATIO` dead-zone | — (jitter handled implicitly by beta floor) |
| threshold/alpha/beta proportional bands | same |
| `log10Root` step | `log10` step function |
| `settled` hysteresis | none (Netflix oscillates; we settle) |
| re-probe every `jitter × probeMultiplier × limit` samples | same (`probeMultiplier` = `PROBE_MULTIPLIER`) |
| anti-drift `activeCount × 2 < limit` | same |
