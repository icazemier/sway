import { sway } from './sway.js';
import { SwayOptions, SwayResult } from './interfaces.js';

/**
 * Map each item to a result with adaptive concurrency control.
 *
 * Ergonomic wrapper around {@link sway} that mirrors the signature of
 * `Array.prototype.map` for async work — the caller supplies an async
 * function `(item, index) => Promise<R>` directly, without wrapping
 * each call in a thunk.
 *
 * Items are pulled lazily from the source iterable, so generators and
 * very large inputs work without materializing the full task array.
 *
 * Rejects on the first error (fail-fast), like {@link sway}.
 *
 * @typeParam T - The input item type
 * @typeParam R - The mapped result type
 * @param items - An iterable of input items
 * @param fn - Async mapping function called with `(item, index)`
 * @param options - Optional tuning parameters for the adaptive controller
 * @returns Mapped values in input order together with performance stats
 *
 * @example
 * ```ts
 * import { sway } from '@icazemier/sway';
 *
 * const { results } = await sway.map(
 *   urls,
 *   async (url) => (await fetch(url)).json()
 * );
 * ```
 */
export function swayMap<T, R>(
  items: Iterable<T>,
  fn: (item: T, index: number) => Promise<R>,
  options?: SwayOptions
): Promise<SwayResult<R>> {
  return sway(toTasks(items, fn), options);
}

function* toTasks<T, R>(
  items: Iterable<T>,
  fn: (item: T, index: number) => Promise<R>
): Iterable<() => Promise<R>> {
  let index = 0;
  for (const item of items) {
    const i = index++;
    yield () => fn(item, i);
  }
}
