# @icazemier/sway

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
