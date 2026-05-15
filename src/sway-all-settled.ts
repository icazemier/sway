import { runSway } from './sway.js';
import { SwayOptions, SwayResult } from './interfaces.js';

/**
 * Run async tasks concurrently with adaptive concurrency control, reporting
 * a settle-result for every task. Never rejects on task failure.
 *
 * Like {@link Promise.allSettled} but with sway's latency-gradient adaptive
 * concurrency limiter. Each task's outcome is reported as a
 * {@link PromiseSettledResult} (`{ status: 'fulfilled', value }` or
 * `{ status: 'rejected', reason }`).
 *
 * The returned promise only rejects if the input iterator itself throws.
 *
 * Rejected tasks are excluded from the controller's latency baseline:
 * a fast failure (e.g. a pre-flight rejection at ~1ms) should not lead
 * the controller to believe the backend is faster than it really is.
 *
 * @typeParam T - The resolved type of each task
 * @param tasks - An iterable of zero-argument async functions (thunks)
 * @param options - Optional tuning parameters for the adaptive controller
 * @returns Settle-results in input order together with performance stats
 *
 * @example
 * ```ts
 * import { sway } from '@icazemier/sway';
 *
 * const { results } = await sway.allSettled(
 *   urls.map(url => () => fetch(url))
 * );
 * for (const r of results) {
 *   if (r.status === 'fulfilled') console.log(r.value.status);
 *   else console.error(r.reason);
 * }
 * ```
 */
export function swayAllSettled<T>(
  tasks: Iterable<() => Promise<T>>,
  options?: SwayOptions
): Promise<SwayResult<PromiseSettledResult<T>>> {
  return runSway(
    wrapTasks(tasks),
    options,
    (result) => result.status === 'fulfilled'
  );
}

function* wrapTasks<T>(
  tasks: Iterable<() => Promise<T>>
): Iterable<() => Promise<PromiseSettledResult<T>>> {
  for (const task of tasks) {
    yield async (): Promise<PromiseSettledResult<T>> => {
      try {
        return { status: 'fulfilled', value: await task() };
      } catch (reason) {
        return { status: 'rejected', reason };
      }
    };
  }
}
