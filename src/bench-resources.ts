/**
 * Simulated resources shared by the benchmarks and the profiling script.
 *
 * These models are inspired by Netflix's concurrency-limits library
 * ({@link https://github.com/Netflix/concurrency-limits}) and the
 * "Performance Under Load" blog post
 * ({@link https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581}).
 *
 * They live here rather than in each harness because a benchmark and a
 * profile of the same scenario have to measure the same thing. Copies drift:
 * change the penalty curve in one and the other quietly reports on a
 * different system.
 *
 * Not part of the published package — excluded from both build tsconfigs.
 */

/**
 * Contention model — service time degrades quadratically beyond optimal
 * concurrency, modelling systems where excess load causes contention (CPU
 * saturation, lock contention, GC pressure). Produces a U-shaped throughput
 * curve: too few is underutilised, too many contends, and the sweet spot in
 * between is maximum throughput.
 */
export function createContentionResource(optimalConcurrency: number) {
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
 * Queuing model — a fixed-capacity resource where excess requests queue
 * behind a semaphore, matching Netflix's TestServer in
 * {@link https://github.com/Netflix/concurrency-limits/blob/master/concurrency-limits-core/src/test/java/com/netflix/concurrency/limits/executor/BlockingAdaptiveExecutorSimulation.java | BlockingAdaptiveExecutorSimulation.java}.
 * Requests beyond capacity wait for a slot, adding real queueing delay to
 * their observed latency — the leading indicator the gradient algorithm is
 * designed to detect.
 */
export function createQueuingResource(
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
 * Shifting model — a contention resource whose optimal concurrency changes
 * partway through the run, so a controller has to notice and re-converge
 * rather than settle once.
 */
export function createShiftingResource(
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
