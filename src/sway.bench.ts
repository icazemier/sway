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
import { bench, describe } from 'vitest';
import { sway } from './sway.js';

const TASK_COUNT = 500;

// ── Resource models ──────────────────────────────────────────────────

/**
 * Contention model: service time degrades under excess concurrency.
 *
 * Below optimal concurrency, tasks complete at base latency with small
 * jitter. Above optimal, latency grows quadratically — modelling real
 * contention effects like CPU cache thrashing, connection pool exhaustion,
 * or GC pressure.
 *
 * @param optimalConcurrency - The sweet spot where throughput is highest
 */
function createContentionResource(optimalConcurrency: number) {
  let inFlight = 0;

  return (baseMs: number): Promise<number> => {
    inFlight++;
    const load = inFlight / optimalConcurrency;
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
 * Queuing model: fixed-capacity resource with FIFO queue.
 *
 * Mirrors Netflix's TestServer which uses a fair Semaphore to model a
 * server with fixed processing capacity. Requests beyond capacity wait
 * in a FIFO queue for a slot to open. The observed task duration includes
 * both queue wait and service time — producing the latency gradient that
 * the controller detects.
 *
 * Service time uses uniform random jitter, matching Netflix's simulation
 * ({@link https://github.com/Netflix/concurrency-limits/blob/master/concurrency-limits-core/src/test/java/com/netflix/concurrency/limits/executor/BlockingAdaptiveExecutorSimulation.java | randomLatency(min, max)}).
 *
 * @param capacity - Max requests processed simultaneously (semaphore permits)
 * @param minServiceMs - Minimum service time per request
 * @param maxServiceMs - Maximum service time per request
 */
function createQueuingResource(
  capacity: number,
  minServiceMs: number,
  maxServiceMs: number
) {
  let active = 0;
  const waiting: (() => void)[] = [];

  return (): Promise<void> => {
    return new Promise((resolve) => {
      const run = () => {
        active++;
        const serviceTime =
          minServiceMs + Math.random() * (maxServiceMs - minServiceMs);
        setTimeout(() => {
          active--;
          resolve();
          // Release next queued request (FIFO, like Java's fair Semaphore)
          const next = waiting.shift();
          if (next) next();
        }, serviceTime);
      };

      if (active < capacity) {
        run();
      } else {
        waiting.push(run);
      }
    });
  };
}

/**
 * Shifting-capacity contention resource: optimal concurrency changes
 * mid-run, inspired by Netflix's gRPC example which cycles through
 * load phases (warm-up → moderate → overload → recovery).
 *
 * This tests the controller's ability to adapt when conditions change —
 * no single fixed concurrency is optimal for the entire run.
 *
 * @param firstCapacity - Optimal concurrency for the first half
 * @param secondCapacity - Optimal concurrency for the second half
 * @param shiftAfter - Number of tasks before the capacity shifts
 */
function createShiftingResource(
  firstCapacity: number,
  secondCapacity: number,
  shiftAfter: number
) {
  let tasksSeen = 0;
  let inFlight = 0;

  return (baseMs: number): Promise<number> => {
    tasksSeen++;
    inFlight++;
    const capacity = tasksSeen <= shiftAfter ? firstCapacity : secondCapacity;
    const load = inFlight / capacity;
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

/**
 * Group 3: Queuing resource (Netflix semaphore model).
 *
 * Mirrors Netflix's BlockingAdaptiveExecutorSimulation: a resource with
 * fixed capacity where excess requests queue in FIFO order. Service time
 * is uniform random matching their randomLatency(min, max).
 *
 * Unlike the contention model, throughput here is capped at capacity /
 * avg_service_time regardless of concurrency — overshooting doesn't
 * slow total throughput, it only deepens the queue. This means fixed
 * pools at any concurrency >= capacity complete in roughly the same
 * wall-clock time.
 *
 * Netflix's limiter is designed for online services where queue depth
 * = tail latency = user pain. Sway correctly detects the queue buildup
 * via the latency gradient and converges near capacity, trading a small
 * amount of batch throughput for controlled queue depth. This is the
 * intended behaviour for the gradient algorithm.
 */
describe('queuing resource (capacity=8, Netflix model)', () => {
  const CAPACITY = 8;

  const makeTasks = () => {
    const resource = createQueuingResource(CAPACITY, 5, 15);
    return Array.from({ length: TASK_COUNT }, () => () => resource());
  };

  bench(
    'fixed pool (concurrency=8) — matches capacity',
    async () => {
      await fixedPool(makeTasks(), 8);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=2) — too low',
    async () => {
      await fixedPool(makeTasks(), 2);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=32) — queue builds',
    async () => {
      await fixedPool(makeTasks(), 32);
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

  bench(
    'fixed pool (concurrency=8) — optimal first half only',
    async () => {
      await fixedPool(makeTasks(), 8);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=4) — optimal second half only',
    async () => {
      await fixedPool(makeTasks(), 4);
    },
    { iterations: 3, warmupIterations: 1 }
  );

  bench(
    'fixed pool (concurrency=6) — compromise',
    async () => {
      await fixedPool(makeTasks(), 6);
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
});
