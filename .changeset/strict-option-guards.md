---
'@icazemier/sway': minor
---

Validate controller options at runtime instead of trusting the type signature. `maxConcurrency`, `minConcurrency`, `initialConcurrency` and `probeInterval` must be positive safe integers, `smoothingFactor` must be greater than 0 and at most 1, and a minimum above the maximum is rejected. Each throws a `RangeError` naming the offending option and value.

Values that are outside these ranges were previously coerced or propagated silently — a non-finite bound could reach the scheduler and stall it. Callers passing such values now get an error at construction. A valid `initialConcurrency` outside the concurrency bounds is still clamped into range.
