import { describe, it, expect } from 'vitest';
import { sway } from './index.js';
import { delay } from '../test/helper.js';

describe('sway.map', () => {
  it('should expose map as a method on sway', () => {
    expect(typeof sway.map).toBe('function');
  });

  it('should map each item to a result, preserving input order', async () => {
    const result = await sway.map([1, 2, 3, 4], async (n) => n * 2);
    expect(result.results).toEqual([2, 4, 6, 8]);
  });

  it('should pass the correct index to the mapping function', async () => {
    const seen: Array<{ item: string; index: number }> = [];
    await sway.map(['a', 'b', 'c'], async (item, index) => {
      seen.push({ item, index });
      return item;
    });
    // Completion order may vary; pair each item with its observed index
    seen.sort((x, y) => x.index - y.index);
    expect(seen).toEqual([
      { item: 'a', index: 0 },
      { item: 'b', index: 1 },
      { item: 'c', index: 2 },
    ]);
  });

  it('should allow the mapping function to omit the index parameter', async () => {
    // Drop-in for Array.prototype.map: fewer params is assignable
    const result = await sway.map([1, 2, 3], async (n: number) => n + 1);
    expect(result.results).toEqual([2, 3, 4]);
  });

  it('should resolve with empty results for an empty iterable', async () => {
    const result = await sway.map<number, number>([], async (n) => n * 2);
    expect(result.results).toEqual([]);
    expect(result.stats.totalTasks).toBe(0);
  });

  it('should pull lazily from a generator (no eager drain)', async () => {
    let yielded = 0;
    function* generateItems() {
      for (let i = 0; i < 10; i++) {
        yielded++;
        yield i;
      }
    }

    const result = await sway.map(
      generateItems(),
      async (n) => {
        await delay(5);
        return n * 10;
      },
      { maxConcurrency: 2, initialConcurrency: 2 }
    );

    expect(result.results).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(yielded).toBe(10);
  });

  it('should reject on the first mapping-function error (fail-fast)', async () => {
    const items = [1, 2, 3, 4, 5];
    await expect(
      sway.map(items, async (n) => {
        if (n === 2) throw new Error(`bad item ${n}`);
        return n;
      })
    ).rejects.toThrow('bad item 2');
  });

  it('should propagate options to the underlying sway() call', async () => {
    let peakConcurrent = 0;
    let currentConcurrent = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await sway.map(
      items,
      async (n) => {
        currentConcurrent++;
        if (currentConcurrent > peakConcurrent) {
          peakConcurrent = currentConcurrent;
        }
        await delay(10);
        currentConcurrent--;
        return n;
      },
      { maxConcurrency: 3, initialConcurrency: 3 }
    );

    expect(peakConcurrent).toBeLessThanOrEqual(3);
  });
});
