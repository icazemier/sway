import { SwayOptions, SwayResult } from './interfaces.js';
import { AdaptiveController } from './adaptive-controller.js';

/**
 * Run async tasks concurrently with adaptive concurrency control.
 *
 * Works like `Promise.all()` but automatically tunes the number of in-flight
 * tasks using a latency-gradient controller that finds the optimal
 * concurrency level.
 * Rejects on the first error (fail-fast), just like `Promise.all()`.
 *
 * @typeParam T - The resolved type of each task
 * @param tasks - An iterable of zero-argument async functions (thunks)
 * @param options - Optional tuning parameters for the adaptive controller
 * @returns Resolved values in input order together with performance stats
 *
 * @example
 * ```ts
 * import { sway } from '@icazemier/sway';
 *
 * const { results, stats } = await sway(
 *   urls.map(url => () => fetch(url).then(r => r.json())),
 *   { maxConcurrency: 16 }
 * );
 * console.log(stats.peakConcurrency, stats.avgConcurrency);
 * ```
 */
export async function sway<T>(
  tasks: Iterable<() => Promise<T>>,
  options?: SwayOptions
): Promise<SwayResult<T>> {
  return runSway(tasks, options, () => true);
}

/**
 * Internal scheduler shared with the variants built on top of {@link sway}
 * (e.g. `sway.allSettled`).
 *
 * `shouldRecord` decides, per settled task, whether its latency should be
 * fed into the adaptive controller. Wrappers use this to keep latencies
 * that do not reflect real backend cost (e.g. pre-flight rejections) out
 * of the controller's learned baseline.
 *
 * Not part of the published API.
 */
export async function runSway<T>(
  tasks: Iterable<() => Promise<T>>,
  options: SwayOptions | undefined,
  shouldRecord: (value: T) => boolean
): Promise<SwayResult<T>> {
  const controller = new AdaptiveController(options);
  const iterator = tasks[Symbol.iterator]();
  const results: T[] = [];
  const startTime = performance.now();

  let nextIndex = 0;
  let activeTasks = 0;
  let settled = false;
  let totalTasks = 0;

  return new Promise<SwayResult<T>>((resolve, reject) => {
    const tryReject = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const scheduleNext = () => {
      while (!settled && activeTasks < controller.getConcurrency()) {
        const next = iterator.next();
        if (next.done) {
          if (activeTasks === 0) {
            settled = true;
            const totalDurationMs = performance.now() - startTime;
            resolve({
              results,
              stats: controller.getStats(totalTasks, totalDurationMs),
            });
          }
          return;
        }

        const index = nextIndex++;
        totalTasks++;
        activeTasks++;

        const taskStart = performance.now();
        next
          .value()
          .then((value) => {
            if (settled) return;
            results[index] = value;
            activeTasks--;
            if (shouldRecord(value)) {
              controller.recordCompletion(performance.now() - taskStart);
            }
            scheduleNext();
          })
          .catch(tryReject);
      }
    };

    scheduleNext();

    if (nextIndex === 0 && activeTasks === 0) {
      settled = true;
      const totalDurationMs = performance.now() - startTime;
      resolve({
        results,
        stats: controller.getStats(0, totalDurationMs),
      });
    }
  });
}
