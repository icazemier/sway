---
name: Benchmarking
description: Work with sway's vitest benchmarks and keep the README benchmark tables accurate
---

# Benchmarking

Sway measures itself with [vitest bench](https://vitest.dev/guide/features.html#benchmarking).
This skill covers the bench files, how to run them, and how the README tables map
to the resource models.

## The bench files

- `src/sway.bench.ts` — plain `sway()` benchmark.
- `src/sway-all-settled.bench.ts` — `sway.allSettled()` benchmark.
- `src/bench-resources.ts` — shared simulated back-pressure resources.

They are ordinary linted source files (no longer eslint-ignored) using the
test-wrapped bench API:

```ts
test('scenario name', async ({ bench }) => {
  await bench('case', async () => { /* ... */ }).run({ iterations: 3, warmupIterations: 1 });
});
```

## Running

```bash
npm run benchmark   # vitest bench
```

A full run takes ~6 minutes (35 benchmarks across the 2 files). Benchmarks are
**not** part of `npm test` or CI — they are a developer tool for measuring the
adaptive controller.

## The `docs/media` trap

`npm run build` runs typedoc, which **copies `src/*.bench.ts` into `docs/media/`**.
Without a guard, `vitest bench` picks up that copy and fails on its unresolved
`./sway.js` import. `vite.config.ts` therefore pins:

```ts
test: { benchmark: { include: ['src/**/*.bench.ts'] } }
```

Do not remove that `include` — it is what keeps the typedoc copy out of bench runs.

## What the benchmark measures

500 tasks against a simulated back-pressure resource whose sweet spot is
`c = 8`. The core claim the bench validates:

> Sway lands within ~1.1–1.2x of the optimal fixed pool — *without being told
> what the optimum is* — while a wrong fixed guess costs far more.

The `sway.allSettled` bench adds a fraction of tasks that fail fast (~1ms
pre-flight rejections), comparing against `Promise.allSettled` and fixed pools.

## Keeping the README tables accurate

The tables in `README.md` (`## Benchmarks`) are produced from these runs. If you
change the controller or add a scenario:

1. Run `npm run benchmark`.
2. Update the README numbers to match the new results.
3. Keep the takeaway framing: adaptive within ~1.2x of optimal; a wrong fixed
   guess is much worse.

Do not hand-invent numbers — every row must be reproducible from a bench run.

## The 100%-failure caveat

At 100% task failure the controller never receives a successful-task latency to
learn from, so it stays at `initialConcurrency` (default 4). That is expected and
documented in the README.

## References

- `references/benchmark-methodology.md` — the resource model and how ratios are computed.
- `src/sway.bench.ts`, `src/sway-all-settled.bench.ts`, `src/bench-resources.ts`.
- `vite.config.ts` — `benchmark.include` guard.
- `README.md` `## Benchmarks` — the published results.
