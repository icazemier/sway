## 2.3.0-beta.2

### Patch Changes

- ae9cda9: Promote the 2.3.0 beta line to stable. The VegasLimit controller rebuild (queue-size estimation, recoverable P25 baseline, jitter dead-zone) shipped as `2.3.0-beta.1`; this changeset graduates it to `2.3.0` on `latest` via the `development → main` promotion.

## 2.3.0-beta.1

### Minor Changes

- 4a42941: Rebuild the adaptive controller faithful to Netflix's `VegasLimit`. The latency-based controller now:

  - Detects queuing via `queueSize = ceil(concurrency × (1 − minLatency / latencyEma))` with proportional decision bands, so it settles near a resource's true capacity instead of climbing to `maxConcurrency` on queuing resources.
  - Uses a recoverable low-percentile baseline (P25 of a rolling window) that stays exact on deterministic resources but recovers after overshoot spikes on jittery ones — fixing a collapse-to-1 regression on noisy/contended resources.
  - Adds a jitter dead-zone so measurement noise is not read as queuing.

  Adds a new `probeMultiplier` option to control how often the no-load baseline is refreshed (default `30`), and exports the `Sway` type (the augmented `sway` function with its `allSettled` and `map` variants).
## 2.2.1

### Patch Changes

- 405d0d9: Security: update @changesets/cli and vitest to address supply chain vulnerabilities


## 2.2.1-beta.0

### Patch Changes

- Security: update @changesets/cli and vitest to address supply chain vulnerabilities

## 2.2.0

### Minor Changes

- fc50c69: Validate controller options at runtime instead of trusting the type signature. `maxConcurrency`, `minConcurrency`, `initialConcurrency` and `probeInterval` must be positive safe integers, `smoothingFactor` must be greater than 0 and at most 1, and a minimum above the maximum is rejected. Each throws a `RangeError` naming the offending option and value.

  Values that are outside these ranges were previously coerced or propagated silently — a non-finite bound could reach the scheduler and stall it. Callers passing such values now get an error at construction. A valid `initialConcurrency` outside the concurrency bounds is still clamped into range.

### Patch Changes

- 329fb52: Fix a hang when tasks complete in 0ms. A zero latency baseline and a zero EMA made the controller's gradient `0/0`, and the resulting `NaN` survived clamping and closed the scheduler's concurrency gate permanently, so the returned promise never settled.
- 0a9c5d6: Fix `require('@icazemier/sway')` throwing `Cannot use import statement outside a module`. The CommonJS build was emitted as ESM and labelled as CommonJS, so every CJS consumer failed at load time.

  The published tarball no longer carries the internal profiling script, `exports` declares explicit `types` conditions for both module systems, and the JSR package ships only its sources instead of the whole repository.

## 2.2.0-beta.0

### Minor Changes

- fc50c69: Validate controller options at runtime instead of trusting the type signature. `maxConcurrency`, `minConcurrency`, `initialConcurrency` and `probeInterval` must be positive safe integers, `smoothingFactor` must be greater than 0 and at most 1, and a minimum above the maximum is rejected. Each throws a `RangeError` naming the offending option and value.

  Values that are outside these ranges were previously coerced or propagated silently — a non-finite bound could reach the scheduler and stall it. Callers passing such values now get an error at construction. A valid `initialConcurrency` outside the concurrency bounds is still clamped into range.

### Patch Changes

- 329fb52: Fix a hang when tasks complete in 0ms. A zero latency baseline and a zero EMA made the controller's gradient `0/0`, and the resulting `NaN` survived clamping and closed the scheduler's concurrency gate permanently, so the returned promise never settled.
- 0a9c5d6: Fix `require('@icazemier/sway')` throwing `Cannot use import statement outside a module`. The CommonJS build was emitted as ESM and labelled as CommonJS, so every CJS consumer failed at load time.

  The published tarball no longer carries the internal profiling script, `exports` declares explicit `types` conditions for both module systems, and the JSR package ships only its sources instead of the whole repository.
