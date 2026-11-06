---
"@icazemier/sway": minor
---

Rebuild the adaptive controller faithful to Netflix's `VegasLimit`. The latency-based controller now:

- Detects queuing via `queueSize = ceil(concurrency × (1 − minLatency / latencyEma))` with proportional decision bands, so it settles near a resource's true capacity instead of climbing to `maxConcurrency` on queuing resources.
- Uses a recoverable low-percentile baseline (P25 of a rolling window) that stays exact on deterministic resources but recovers after overshoot spikes on jittery ones — fixing a collapse-to-1 regression on noisy/contended resources.
- Adds a jitter dead-zone so measurement noise is not read as queuing.

Adds a new `probeMultiplier` option to control how often the no-load baseline is refreshed (default `30`), and exports the `Sway` type (the augmented `sway` function with its `allSettled` and `map` variants).
