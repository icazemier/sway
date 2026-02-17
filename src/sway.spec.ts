import { describe, it, expect } from 'vitest';
import { sway } from './sway.js';
import { createTask, createFailingTask } from '../test/helper.js';

describe('sway', () => {
  it('should resolve an empty task array', async () => {
    const result = await sway([]);
    expect(result.results).toEqual([]);
    expect(result.stats.totalTasks).toBe(0);
  });

  it('should resolve a single task', async () => {
    const tasks = [createTask('hello', 10)];
    const result = await sway(tasks);
    expect(result.results).toEqual(['hello']);
    expect(result.stats.totalTasks).toBe(1);
  });

  it('should preserve result ordering', async () => {
    const tasks = [
      createTask('slow', 50),
      createTask('fast', 10),
      createTask('medium', 30),
    ];
    const result = await sway(tasks);
    expect(result.results).toEqual(['slow', 'fast', 'medium']);
  });

  it('should handle many tasks', async () => {
    const tasks = Array.from({ length: 100 }, (_, i) =>
      createTask(i, Math.random() * 10)
    );
    const result = await sway(tasks);
    expect(result.results).toHaveLength(100);
    expect(result.results).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('should reject on first error (fail-fast)', async () => {
    const error = new Error('task failed');
    const tasks = [
      createTask('ok', 50),
      createFailingTask(error, 10),
      createTask('also ok', 50),
    ];
    await expect(sway(tasks)).rejects.toThrow('task failed');
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

    const result = await sway(tasks, {
      maxConcurrency: 3,
      initialConcurrency: 3,
    });
    expect(peakConcurrent).toBeLessThanOrEqual(3);
    expect(result.results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('should work with an iterable (generator)', async () => {
    function* generateTasks() {
      for (let i = 0; i < 5; i++) {
        yield createTask(i, 10);
      }
    }

    const result = await sway(generateTasks());
    expect(result.results).toEqual([0, 1, 2, 3, 4]);
    expect(result.stats.totalTasks).toBe(5);
  });

  it('should report performance stats', async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => createTask(i, 5));
    const result = await sway(tasks, { initialConcurrency: 4 });

    expect(result.stats.totalTasks).toBe(20);
    expect(result.stats.totalDurationMs).toBeGreaterThan(0);
    expect(result.stats.peakConcurrency).toBeGreaterThanOrEqual(1);
    expect(result.stats.avgConcurrency).toBeGreaterThan(0);
  });

  it('should handle tasks with different return types', async () => {
    const tasks = [createTask(42, 10), createTask(100, 10), createTask(0, 10)];
    const result = await sway(tasks);
    expect(result.results).toEqual([42, 100, 0]);
  });

  it('should work with minConcurrency of 1', async () => {
    const tasks = [createTask('a', 10), createTask('b', 10)];
    const result = await sway(tasks, {
      minConcurrency: 1,
      maxConcurrency: 1,
      initialConcurrency: 1,
    });
    expect(result.results).toEqual(['a', 'b']);
  });

  it('should adapt concurrency with variable latency tasks', async () => {
    // Fast tasks first, then slower ones
    const tasks = [
      ...Array.from({ length: 16 }, (_, i) => createTask(i, 5)),
      ...Array.from({ length: 16 }, (_, i) => createTask(i + 16, 20)),
    ];

    const result = await sway(tasks, {
      initialConcurrency: 4,
      probeInterval: 4,
    });

    expect(result.results).toHaveLength(32);
    expect(result.stats.totalTasks).toBe(32);
    expect(result.stats.totalDurationMs).toBeGreaterThan(0);
  });
});
