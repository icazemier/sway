import { describe, it, expect } from 'vitest';
import { sway } from './index.js';
import { createTask, createFailingTask } from '../test/helper.js';

describe('sway.allSettled', () => {
  it('should expose allSettled as a method on sway', () => {
    expect(typeof sway.allSettled).toBe('function');
  });

  it('should return fulfilled results when all tasks succeed', async () => {
    const tasks = [
      createTask('a', 10),
      createTask('b', 10),
      createTask('c', 10),
    ];
    const result = await sway.allSettled(tasks);
    expect(result.results).toEqual([
      { status: 'fulfilled', value: 'a' },
      { status: 'fulfilled', value: 'b' },
      { status: 'fulfilled', value: 'c' },
    ]);
  });

  it('should return rejected results when all tasks fail (and never throws)', async () => {
    const errorA = new Error('a-failed');
    const errorB = new Error('b-failed');
    const tasks = [
      createFailingTask(errorA, 10),
      createFailingTask(errorB, 10),
    ];
    const result = await sway.allSettled(tasks);
    expect(result.results).toEqual([
      { status: 'rejected', reason: errorA },
      { status: 'rejected', reason: errorB },
    ]);
  });

  it('should handle a mix of fulfilled and rejected tasks', async () => {
    const err = new Error('boom');
    const tasks = [
      createTask('a', 10),
      createFailingTask(err, 10),
      createTask('c', 10),
      createFailingTask(err, 10),
      createTask('e', 10),
    ];
    const result = await sway.allSettled(tasks);
    expect(result.results).toEqual([
      { status: 'fulfilled', value: 'a' },
      { status: 'rejected', reason: err },
      { status: 'fulfilled', value: 'c' },
      { status: 'rejected', reason: err },
      { status: 'fulfilled', value: 'e' },
    ]);
  });

  it('should resolve with empty results for an empty iterable', async () => {
    const result = await sway.allSettled([]);
    expect(result.results).toEqual([]);
    expect(result.stats.totalTasks).toBe(0);
  });

  it('should pull lazily from a generator', async () => {
    let yielded = 0;
    function* generateTasks() {
      for (let i = 0; i < 10; i++) {
        yielded++;
        yield createTask(i, 5);
      }
    }

    const result = await sway.allSettled(generateTasks(), {
      maxConcurrency: 2,
      initialConcurrency: 2,
    });

    expect(result.results).toHaveLength(10);
    expect(yielded).toBe(10);
    for (const r of result.results) {
      expect(r.status).toBe('fulfilled');
    }
  });

  it('should respect maxConcurrency', async () => {
    let peakConcurrent = 0;
    let currentConcurrent = 0;

    const tasks = Array.from({ length: 20 }, (_, i) => () => {
      currentConcurrent++;
      if (currentConcurrent > peakConcurrent) {
        peakConcurrent = currentConcurrent;
      }
      return new Promise<number>((resolve) => {
        setTimeout(() => {
          currentConcurrent--;
          resolve(i);
        }, 10);
      });
    });

    await sway.allSettled(tasks, {
      maxConcurrency: 3,
      initialConcurrency: 3,
    });
    expect(peakConcurrent).toBeLessThanOrEqual(3);
  });

  it('should preserve rejection reason identity for various reason types', async () => {
    const errorObj = new Error('err');
    const plainObj = { code: 'X', message: 'plain' };
    const tasks: Array<() => Promise<never>> = [
      () => Promise.reject(errorObj),
      () => Promise.reject(plainObj),
      () => Promise.reject('string-reason'),
      () => Promise.reject(42),
      () => Promise.reject(null),
      () => Promise.reject(undefined),
    ];

    const result = await sway.allSettled(tasks);

    expect(result.results).toHaveLength(6);
    for (const r of result.results) {
      expect(r.status).toBe('rejected');
    }
    if (result.results[0].status === 'rejected') {
      expect(result.results[0].reason).toBe(errorObj);
    }
    if (result.results[1].status === 'rejected') {
      expect(result.results[1].reason).toBe(plainObj);
    }
    if (result.results[2].status === 'rejected') {
      expect(result.results[2].reason).toBe('string-reason');
    }
    if (result.results[3].status === 'rejected') {
      expect(result.results[3].reason).toBe(42);
    }
    if (result.results[4].status === 'rejected') {
      expect(result.results[4].reason).toBe(null);
    }
    if (result.results[5].status === 'rejected') {
      expect(result.results[5].reason).toBe(undefined);
    }
  });

  it('should count all tasks in stats.totalTasks even when all fail', async () => {
    const err = new Error('all-fail');
    const tasks = Array.from({ length: 15 }, () => createFailingTask(err, 5));
    const result = await sway.allSettled(tasks);
    expect(result.stats.totalTasks).toBe(15);
  });

  it('should not feed failed tasks into the adaptive controller', async () => {
    // 100% failures → controller is never given a latency sample → no probes,
    // no adjustments, concurrency stays at the initial level. This is what
    // protects the latency baseline from being skewed by fast pre-flight
    // rejections in mixed workloads.
    const tasks = Array.from(
      { length: 100 },
      () => () => Promise.reject(new Error('fail'))
    );
    const result = await sway.allSettled(tasks, {
      initialConcurrency: 4,
      maxConcurrency: 64,
      probeInterval: 8,
    });
    expect(result.stats.peakConcurrency).toBe(4);
    expect(result.stats.adjustments).toBe(0);
  });

  it('should reject if the input iterator itself throws', async () => {
    const iteratorError = new Error('iterator broke');
    function* badIterator(): Generator<() => Promise<number>> {
      yield createTask(1, 5);
      throw iteratorError;
    }
    await expect(sway.allSettled(badIterator())).rejects.toThrow(
      'iterator broke'
    );
  });

  it('should preserve input order when tasks settle out of order', async () => {
    const tasks = [
      createTask('first', 50),
      createTask('second', 30),
      createFailingTask(new Error('mid-fail'), 20),
      createTask('fourth', 10),
      createTask('last', 5),
    ];

    const result = await sway.allSettled(tasks);
    expect(result.results[0]).toEqual({ status: 'fulfilled', value: 'first' });
    expect(result.results[1]).toEqual({ status: 'fulfilled', value: 'second' });
    expect(result.results[2].status).toBe('rejected');
    expect(result.results[3]).toEqual({ status: 'fulfilled', value: 'fourth' });
    expect(result.results[4]).toEqual({ status: 'fulfilled', value: 'last' });
  });
});
