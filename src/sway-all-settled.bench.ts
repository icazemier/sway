/**
 * Benchmarks for sway.allSettled under workloads with task failures.
 *
 * Tests whether the adaptive controller still converges sensibly when a
 * fraction of tasks fail fast (~1ms) — failures would otherwise skew the
 * learned latency baseline because they look like very fast tasks.
 *
 * The contention model is the same as {@link ./sway.bench.ts}: service
 * time degrades quadratically beyond an optimal concurrency. Failure
 * rates sweep from realistic (10%) through pathological (100%).
 *
 * At low failure rates, contention dominates → fixed pools near optimal
 * win. At 100% failure, there is no contention (failed calls cost ~1ms)
 * → unbounded concurrency wins. Sway should track the best approach in
 * both regimes without being told which scenario it is in.
 */
import { bench, describe } from 'vitest';
import { sway } from './index.js';
import { createContentionResource } from './bench-resources.js';

const TASK_COUNT = 500;
const FAIL_MS = 1;
const OPTIMAL = 8;
const BASE_MS = 10;

/**
 * Build a flaky-task array. Failed tasks short-circuit before touching
 * the contention resource — modelling a pre-flight rejection (circuit
 * breaker, 4xx, client-side validation) that costs ~FAIL_MS and never
 * contributes to backend load.
 */
function makeTasks(failureRate: number) {
  const resource = createContentionResource(OPTIMAL);
  return Array.from({ length: TASK_COUNT }, () => async (): Promise<number> => {
    if (Math.random() < failureRate) {
      await new Promise((r) => setTimeout(r, FAIL_MS));
      throw new Error('flaky');
    }
    return resource(BASE_MS);
  });
}

// ── Fixed-pool baseline (allSettled-style, never bails on error) ─────

async function fixedPoolAllSettled<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  const iterator = tasks[Symbol.iterator]();
  let nextIndex = 0;
  let active = 0;

  return new Promise((resolve) => {
    const next = () => {
      while (active < concurrency) {
        const item = iterator.next();
        if (item.done) {
          if (active === 0) resolve(results);
          return;
        }
        const idx = nextIndex++;
        active++;
        item.value().then(
          (value) => {
            results[idx] = { status: 'fulfilled', value };
            active--;
            next();
          },
          (reason) => {
            results[idx] = { status: 'rejected', reason };
            active--;
            next();
          }
        );
      }
    };
    next();
  });
}

// ── Benchmark groups: 3 failure rates × 4 approaches ─────────────────

for (const failureRate of [0.1, 0.5, 1.0]) {
  const pct = Math.round(failureRate * 100);

  describe(`sway.allSettled under contention (optimal=${OPTIMAL}, failures=${pct}%)`, () => {
    bench(
      'Promise.allSettled — unbounded',
      async () => {
        await Promise.allSettled(makeTasks(failureRate).map((t) => t()));
      },
      { iterations: 3, warmupIterations: 1 }
    );

    bench(
      'fixed pool (concurrency=8) — matches contention optimum',
      async () => {
        await fixedPoolAllSettled(makeTasks(failureRate), 8);
      },
      { iterations: 3, warmupIterations: 1 }
    );

    bench(
      'fixed pool (concurrency=32) — too high under contention',
      async () => {
        await fixedPoolAllSettled(makeTasks(failureRate), 32);
      },
      { iterations: 3, warmupIterations: 1 }
    );

    bench(
      'sway.allSettled (defaults)',
      async () => {
        await sway.allSettled(makeTasks(failureRate));
      },
      { iterations: 3, warmupIterations: 1 }
    );
  });
}
