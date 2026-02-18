import { bench, describe } from 'vitest';
import { sway } from './sway.js';

const TASK_COUNT = 500;

/**
 * Simulates a resource with back-pressure. Latency is minimal up to an
 * optimal concurrency, then increases sharply as the "server" becomes
 * overloaded. This models real-world behaviour like connection pool
 * exhaustion, rate limiting, or CPU saturation.
 *
 * @param optimalConcurrency - The sweet spot where throughput is highest
 */
function createBackPressureResource(optimalConcurrency: number) {
  let inFlight = 0;

  return (baseMs: number): Promise<number> => {
    inFlight++;
    const load = inFlight / optimalConcurrency;
    // Below optimal: base latency with small jitter
    // Above optimal: latency grows quadratically (contention)
    const penalty = load > 1 ? baseMs * (load - 1) ** 2 * 4 : 0;
    const jitter = Math.random() * baseMs * 0.2;
    const actualDelay = baseMs + penalty + jitter;

    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight--;
        resolve(actualDelay);
      }, actualDelay);
    });
  };
}

/**
 * Fixed-concurrency runner for comparison baseline.
 */
async function fixedPool<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  const iterator = tasks[Symbol.iterator]();
  let nextIndex = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    const next = () => {
      while (active < concurrency) {
        const item = iterator.next();
        if (item.done) {
          if (active === 0) resolve(results);
          return;
        }
        const idx = nextIndex++;
        active++;
        item
          .value()
          .then((v) => {
            results[idx] = v;
            active--;
            next();
          })
          .catch(reject);
      }
    };
    next();
  });
}

/**
 * Scenario: server with optimal concurrency around 8.
 * - Too few concurrent requests: underutilised, slow total time
 * - Too many concurrent requests: contention, latency spikes
 * - Sway should converge near the optimum without knowing it upfront
 */
describe('back-pressure resource (optimal=8)', () => {
  const OPTIMAL = 8;
  const BASE_MS = 10;

  const makeTasks = () => {
    const resource = createBackPressureResource(OPTIMAL);
    return Array.from({ length: TASK_COUNT }, () => () => resource(BASE_MS));
  };

  bench(
    'fixed pool (concurrency=2) — too low',
    async () => {
      await fixedPool(makeTasks(), 2);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=8) — optimal',
    async () => {
      await fixedPool(makeTasks(), 8);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=32) — too high',
    async () => {
      await fixedPool(makeTasks(), 32);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=64) — way too high',
    async () => {
      await fixedPool(makeTasks(), 64);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'sway (defaults, initial=4)',
    async () => {
      await sway(makeTasks());
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'sway (aggressive, initial=8)',
    async () => {
      await sway(makeTasks(), {
        initialConcurrency: 8,
        probeInterval: 4,
        smoothingFactor: 0.6,
      });
    },
    { iterations: 3, warmupIterations: 1 }
  );
});

/**
 * Scenario: tight resource with optimal concurrency around 4.
 * Aggressive penalty for overshooting — like a database connection pool.
 */
describe('back-pressure resource (optimal=4)', () => {
  const OPTIMAL = 4;
  const BASE_MS = 15;

  const makeTasks = () => {
    const resource = createBackPressureResource(OPTIMAL);
    return Array.from({ length: TASK_COUNT }, () => () => resource(BASE_MS));
  };

  bench(
    'fixed pool (concurrency=4) — optimal',
    async () => {
      await fixedPool(makeTasks(), 4);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=16) — too high',
    async () => {
      await fixedPool(makeTasks(), 16);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=64) — way too high',
    async () => {
      await fixedPool(makeTasks(), 64);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'sway (defaults, initial=4)',
    async () => {
      await sway(makeTasks());
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'sway (calm, initial=2)',
    async () => {
      await sway(makeTasks(), {
        initialConcurrency: 2,
        probeInterval: 8,
        smoothingFactor: 0.2,
      });
    },
    { iterations: 3, warmupIterations: 1 }
  );
});
