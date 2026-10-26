/**
 * Benchmarks for sway's adaptive concurrency controller.
 *
 * Resource models are inspired by Netflix's concurrency-limits library
 * ({@link https://github.com/Netflix/concurrency-limits}) and the
 * "Performance Under Load" blog post
 * ({@link https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581}).
 *
 * Two resource models are used:
 *
 * 1. **Contention model** — Service time degrades quadratically beyond
 *    optimal concurrency. Models systems where excess load causes
 *    contention (CPU saturation, lock contention, GC pressure).
 *    This creates a U-shaped throughput curve: too few = underutilised,
 *    too many = contention, sweet spot = maximum throughput.
 *
 * 2. **Queuing model** — Fixed-capacity resource where excess requests
 *    queue behind a semaphore, matching Netflix's TestServer in
 *    {@link https://github.com/Netflix/concurrency-limits/blob/master/concurrency-limits-core/src/test/java/com/netflix/concurrency/limits/executor/BlockingAdaptiveExecutorSimulation.java | BlockingAdaptiveExecutorSimulation.java}.
 *    Requests beyond capacity wait for a slot, adding real queueing
 *    delay to their observed latency — the leading indicator that the
 *    gradient algorithm is designed to detect.
 *
 * Each group compares sway against fixed-concurrency baselines to show
 * how close adaptive control gets to the optimal (known-in-advance)
 * fixed pool.
 */
import { describe, test } from 'vitest';
import { sway } from './sway.js';
import {
  createContentionResource,
  createQueuingResource,
  createShiftingResource,
} from './bench-resources.js';

const TASK_COUNT = 500;

// ── Fixed-pool baseline runner ───────────────────────────────────────

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

// ── Benchmark groups ─────────────────────────────────────────────────

/**
 * Group 1: Contention model with optimal concurrency = 8.
 *
 * Models a resource where excess concurrency degrades service time
 * (e.g., API with connection pool, database under lock pressure).
 * Sway should converge near the optimum and complete within ~1.2x
 * of the optimal fixed pool.
 */
describe('contention resource (optimal=8)', () => {
  const OPTIMAL = 8;
  const BASE_MS = 10;

  const makeTasks = () => {
    const resource = createContentionResource(OPTIMAL);
    return Array.from({ length: TASK_COUNT }, () => () => resource(BASE_MS));
  };

  test('fixed pool (concurrency=2) — too low', async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=2) — too low', async () => {
        await fixedPool(makeTasks(), 2);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('fixed pool (concurrency=8) — optimal', async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=8) — optimal', async () => {
        await fixedPool(makeTasks(), 8);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('fixed pool (concurrency=32) — too high', async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=32) — too high', async () => {
        await fixedPool(makeTasks(), 32);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('fixed pool (concurrency=64) — way too high', { timeout: 600_000 }, async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=64) — way too high', async () => {
        await fixedPool(makeTasks(), 64);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('sway (defaults, initial=4)', async ({ bench }) => {
    await bench(
      'sway (defaults, initial=4)', async () => {
        await sway(makeTasks());
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('sway (aggressive, initial=8)', async ({ bench }) => {
    await bench(
      'sway (aggressive, initial=8)', async () => {
        await sway(makeTasks(), {
          initialConcurrency: 8,
          probeInterval: 4,
          smoothingFactor: 0.6,
        });
      }).run({ iterations: 3, warmupIterations: 1 });
  });
});

/**
 * Group 2: Contention model with tight capacity (optimal = 4).
 *
 * Like a small database connection pool — overshooting is punished
 * heavily. The quadratic penalty makes latency 4× worse at just 2×
 * the optimal concurrency.
 */
describe('contention resource (optimal=4)', () => {
  const OPTIMAL = 4;
  const BASE_MS = 15;

  const makeTasks = () => {
    const resource = createContentionResource(OPTIMAL);
    return Array.from({ length: TASK_COUNT }, () => () => resource(BASE_MS));
  };

  test('fixed pool (concurrency=4) — optimal', async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=4) — optimal', async () => {
        await fixedPool(makeTasks(), 4);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('fixed pool (concurrency=16) — too high', { timeout: 600_000 }, async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=16) — too high', async () => {
        await fixedPool(makeTasks(), 16);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('fixed pool (concurrency=64) — way too high', { timeout: 600_000 }, async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=64) — way too high', async () => {
        await fixedPool(makeTasks(), 64);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('sway (defaults, initial=4)', async ({ bench }) => {
    await bench(
      'sway (defaults, initial=4)', async () => {
        await sway(makeTasks());
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('sway (calm, initial=2)', async ({ bench }) => {
    await bench(
      'sway (calm, initial=2)', async () => {
        await sway(makeTasks(), {
          initialConcurrency: 2,
          probeInterval: 8,
          smoothingFactor: 0.2,
        });
      }).run({ iterations: 3, warmupIterations: 1 });
  });
});

/**
 * Queuing resource benchmark groups.
 *
 * On a queuing resource, throughput is capped at `capacity / serviceTime`
 * regardless of concurrency, so wall-clock ms is flat/noise-dominated and
 * cannot reveal overshoot. What actually matters — and what the controller
 * controls — is the **concurrency it settles on** and the **queue depth**
 * (tail latency) that overshoot creates. So these groups log the sway run's
 * measured peak/avg concurrency right next to the fixed-pool optimum, making
 * the overshoot (or its absence) visible in the bench output.
 *
 * Netflix's limiter is designed for online services where queue depth =
 * tail latency = user pain. Sway converges near capacity, trading a small
 * amount of batch throughput for controlled queue depth.
 */
describe('queuing resource (capacity=8, Netflix model)', () => {
  const CAPACITY = 8;

  const makeTasks = () => {
    const resource = createQueuingResource(CAPACITY, 5, 15);
    return Array.from({ length: TASK_COUNT }, () => () => resource());
  };

  test('fixed pool (concurrency=8) — matches capacity', async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=8) — matches capacity', async () => {
        await fixedPool(makeTasks(), 8);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('fixed pool (concurrency=2) — too low', async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=2) — too low', async () => {
        await fixedPool(makeTasks(), 2);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('fixed pool (concurrency=32) — queue builds', async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=32) — queue builds', async () => {
        await fixedPool(makeTasks(), 32);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('sway (defaults, initial=4)', async ({ bench }) => {
    await bench(
      'sway (defaults, initial=4)', async () => {
        const { stats } = await sway(makeTasks());
        // eslint-disable-next-line no-console
        console.log(
          `  [sway] peak=${stats.peakConcurrency} avg=${stats.avgConcurrency.toFixed(2)}`
        );
      }).run({ iterations: 3, warmupIterations: 1 });
  });
});

/**
 * Group 3b: Queuing resource with a single slot (capacity=1).
 *
 * The worst-case overshoot scenario for the old controller: optimum is 1,
 * but a decaying baseline let it climb to 7-10. The rebuilt controller must
 * descend to 1 and hold. Peak/avg concurrency are logged next to the optimum.
 */
describe('queuing resource (capacity=1, Netflix model)', () => {
  const CAPACITY = 1;

  const makeTasks = () => {
    const resource = createQueuingResource(CAPACITY, 5, 15);
    return Array.from({ length: TASK_COUNT }, () => () => resource());
  };

  test('fixed pool (concurrency=1) — matches capacity', async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=1) — matches capacity', async () => {
        await fixedPool(makeTasks(), 1);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('sway (defaults, initial=4)', async ({ bench }) => {
    await bench(
      'sway (defaults, initial=4)', async () => {
        const { stats } = await sway(makeTasks());
        // eslint-disable-next-line no-console
        console.log(
          `  [sway] peak=${stats.peakConcurrency} avg=${stats.avgConcurrency.toFixed(2)}`
        );
      }).run({ iterations: 3, warmupIterations: 1 });
  });
});

/**
 * Group 3c: Queuing resource with four slots (capacity=4).
 *
 * Optimum is 4; the old controller hovered at 5-6. The rebuilt controller
 * should settle at ~4. Peak/avg concurrency are logged next to the optimum.
 */
describe('queuing resource (capacity=4, Netflix model)', () => {
  const CAPACITY = 4;

  const makeTasks = () => {
    const resource = createQueuingResource(CAPACITY, 5, 15);
    return Array.from({ length: TASK_COUNT }, () => () => resource());
  };

  test('fixed pool (concurrency=4) — matches capacity', async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=4) — matches capacity', async () => {
        await fixedPool(makeTasks(), 4);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('sway (defaults, initial=4)', async ({ bench }) => {
    await bench(
      'sway (defaults, initial=4)', async () => {
        const { stats } = await sway(makeTasks());
        // eslint-disable-next-line no-console
        console.log(
          `  [sway] peak=${stats.peakConcurrency} avg=${stats.avgConcurrency.toFixed(2)}`
        );
      }).run({ iterations: 3, warmupIterations: 1 });
  });
});

/**
 * Group 4: Shifting capacity — optimal concurrency changes mid-run.
 *
 * Inspired by Netflix's gRPC example which cycles through load phases
 * (warm-up at 50 RPS → moderate at 90 → spike at 200 → recovery at 100).
 * Here the resource starts with capacity=8, then tightens to capacity=4
 * halfway through. No single fixed concurrency is optimal for both halves.
 *
 * Sway should adapt to the shift and outperform any static choice.
 */
describe('shifting capacity (8→4 at midpoint)', () => {
  const BASE_MS = 10;

  const makeTasks = () => {
    const resource = createShiftingResource(8, 4, TASK_COUNT / 2);
    return Array.from({ length: TASK_COUNT }, () => () => resource(BASE_MS));
  };

  test('fixed pool (concurrency=8) — optimal first half only', async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=8) — optimal first half only', async () => {
        await fixedPool(makeTasks(), 8);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('fixed pool (concurrency=4) — optimal second half only', async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=4) — optimal second half only', async () => {
        await fixedPool(makeTasks(), 4);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('fixed pool (concurrency=6) — compromise', async ({ bench }) => {
    await bench(
      'fixed pool (concurrency=6) — compromise', async () => {
        await fixedPool(makeTasks(), 6);
      }).run({ iterations: 3, warmupIterations: 1 });
  });

  test('sway (defaults, initial=4)', async ({ bench }) => {
    await bench(
      'sway (defaults, initial=4)', async () => {
        await sway(makeTasks());
      }).run({ iterations: 3, warmupIterations: 1 });
  });
});
