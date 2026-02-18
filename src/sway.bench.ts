import { bench, describe } from 'vitest';
import { sway } from './sway.js';

const TASK_COUNT = 1000;
const BASE_DELAY = 10;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const makeTasks = (count: number, delayMs: number) =>
  Array.from({ length: count }, (_, i) => () => delay(delayMs).then(() => i));

const makeVariableTasks = (count: number, baseMs: number) =>
  Array.from({ length: count }, (_, i) => () => {
    const jitter = 0.5 + Math.random();
    const outlier = Math.random() < 0.1 ? 5 : 1;
    return delay(baseMs * jitter * outlier).then(() => i);
  });

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

describe('sway vs fixed concurrency — uniform latency', () => {
  bench(
    'fixed pool (concurrency=4)',
    async () => {
      await fixedPool(makeTasks(TASK_COUNT, BASE_DELAY), 4);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=16)',
    async () => {
      await fixedPool(makeTasks(TASK_COUNT, BASE_DELAY), 16);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=64)',
    async () => {
      await fixedPool(makeTasks(TASK_COUNT, BASE_DELAY), 64);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'sway (defaults)',
    async () => {
      await sway(makeTasks(TASK_COUNT, BASE_DELAY));
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'sway (aggressive)',
    async () => {
      await sway(makeTasks(TASK_COUNT, BASE_DELAY), {
        initialConcurrency: 8,
        probeInterval: 4,
        smoothingFactor: 0.6,
      });
    },
    { iterations: 3, warmupIterations: 1 }
  );
});

describe('sway vs fixed concurrency — variable latency with outliers', () => {
  bench(
    'fixed pool (concurrency=4)',
    async () => {
      await fixedPool(makeVariableTasks(TASK_COUNT, BASE_DELAY), 4);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=16)',
    async () => {
      await fixedPool(makeVariableTasks(TASK_COUNT, BASE_DELAY), 16);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=64)',
    async () => {
      await fixedPool(makeVariableTasks(TASK_COUNT, BASE_DELAY), 64);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'sway (defaults)',
    async () => {
      await sway(makeVariableTasks(TASK_COUNT, BASE_DELAY));
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'sway (aggressive)',
    async () => {
      await sway(makeVariableTasks(TASK_COUNT, BASE_DELAY), {
        initialConcurrency: 8,
        probeInterval: 4,
        smoothingFactor: 0.6,
      });
    },
    { iterations: 3, warmupIterations: 1 }
  );
});
