import { describe, it, expect } from 'vitest';
import { AdaptiveController } from './adaptive-controller.js';

describe('AdaptiveController', () => {
  // ── Defaults & clamping ────────────────────────────────────────────

  it('should use default concurrency', () => {
    const controller = new AdaptiveController();
    expect(controller.getConcurrency()).toBe(4);
  });

  it('should respect initialConcurrency option', () => {
    const controller = new AdaptiveController({ initialConcurrency: 10 });
    expect(controller.getConcurrency()).toBe(10);
  });

  it('should clamp initialConcurrency to bounds', () => {
    const over = new AdaptiveController({
      initialConcurrency: 100,
      maxConcurrency: 16,
    });
    expect(over.getConcurrency()).toBe(16);

    // A valid starting point below the floor is lifted to it...
    const under = new AdaptiveController({
      initialConcurrency: 1,
      minConcurrency: 2,
    });
    expect(under.getConcurrency()).toBe(2);

    // ...but zero is not a starting point, so it is rejected rather than
    // silently coerced into one.
    expect(
      () => new AdaptiveController({ initialConcurrency: 0, minConcurrency: 2 })
    ).toThrow(RangeError);
  });

  // ── Probe window ───────────────────────────────────────────────────

  it('should not adjust before first full probe window', () => {
    const controller = new AdaptiveController({
      probeInterval: 8,
      initialConcurrency: 4,
    });

    // Only 7 completions — not enough to trigger a probe
    for (let i = 0; i < 7; i++) {
      controller.recordCompletion(10);
    }
    expect(controller.getConcurrency()).toBe(4);
  });

  // ── Latency-gradient behaviour ─────────────────────────────────────

  it('should increase concurrency when latency stays near minimum (gradient ≈ 1)', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      smoothingFactor: 1.0,
    });

    // All tasks at the same low latency → gradient = 1
    // newLimit = 4 * 1 + √4 = 4 + 2 = 6
    for (let i = 0; i < 4; i++) {
      controller.recordCompletion(10);
    }
    expect(controller.getConcurrency()).toBe(6);
  });

  it('should decrease concurrency when latency increases (gradient < 1)', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 10,
      smoothingFactor: 1.0,
    });

    // First completion sets minLatency = 10
    controller.recordCompletion(10);

    // Next 3 at high latency (50ms) → with smoothingFactor=1, latencyEma = 50
    // gradient = 10/50 = 0.2
    // newLimit = 10 * 0.2 + √10 = 2 + 3.16 = 5.16 → round to 5
    for (let i = 0; i < 3; i++) {
      controller.recordCompletion(50);
    }
    expect(controller.getConcurrency()).toBe(5);
  });

  it('should track minLatency as the lowest observed duration', () => {
    const controller = new AdaptiveController({
      probeInterval: 8,
      initialConcurrency: 4,
      smoothingFactor: 1.0,
    });

    // Record various latencies — min should be learned as 5
    controller.recordCompletion(20);
    controller.recordCompletion(5); // new minimum
    controller.recordCompletion(15);
    controller.recordCompletion(10);

    // After 4 completions (less than probeInterval=8), no adjustment yet
    expect(controller.getConcurrency()).toBe(4);

    // Fill remaining window with latency = 5 (matching min)
    // With sf=1.0, latencyEma = 5 (last sample)
    // gradient = 5/5 = 1, newLimit = 4*1 + √4 = 6
    for (let i = 0; i < 4; i++) {
      controller.recordCompletion(5);
    }
    expect(controller.getConcurrency()).toBe(6);
  });

  // ── Clamping ───────────────────────────────────────────────────────

  it('should not exceed maxConcurrency', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      maxConcurrency: 5,
      smoothingFactor: 1.0,
    });

    // gradient = 1 → newLimit = 4 + 2 = 6, clamped to 5
    for (let i = 0; i < 4; i++) {
      controller.recordCompletion(10);
    }
    expect(controller.getConcurrency()).toBe(5);
  });

  it('should not go below minConcurrency', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      minConcurrency: 3,
      smoothingFactor: 1.0,
    });

    // First at low latency sets minLatency = 1
    controller.recordCompletion(1);

    // Rest at very high latency → gradient ≈ 0, newLimit ≈ 0 + √4 = 2
    // Clamped to minConcurrency = 3
    for (let i = 0; i < 3; i++) {
      controller.recordCompletion(1000);
    }
    expect(controller.getConcurrency()).toBe(3);
  });

  // ── Stats ──────────────────────────────────────────────────────────

  it('should report correct stats', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      smoothingFactor: 1.0,
    });

    // One probe window at constant latency → increases to 6
    for (let i = 0; i < 4; i++) {
      controller.recordCompletion(10);
    }
    expect(controller.getConcurrency()).toBe(6);

    const stats = controller.getStats(4, 300);
    expect(stats.totalTasks).toBe(4);
    expect(stats.totalDurationMs).toBe(300);
    expect(stats.peakConcurrency).toBe(6);
    expect(stats.adjustments).toBe(1);
    // All 4 samples recorded at concurrency 4 (adjustment happened at the end)
    expect(stats.avgConcurrency).toBe(4);
  });

  // ── Smoothing ──────────────────────────────────────────────────────

  it('should use EMA smoothing to dampen changes', () => {
    const fast = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 10,
      smoothingFactor: 1.0, // no smoothing
    });

    const slow = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 10,
      smoothingFactor: 0.1, // heavy smoothing
    });

    // Record one low-latency then three high-latency
    const durations = [5, 50, 50, 50];
    for (const d of durations) {
      fast.recordCompletion(d);
      slow.recordCompletion(d);
    }

    // With smoothingFactor=1.0, EMA = 50, gradient = 5/50 = 0.1 → big drop
    // With smoothingFactor=0.1, EMA tracks slower → gradient closer to 1 → smaller drop
    expect(slow.getConcurrency()).toBeGreaterThan(fast.getConcurrency());
  });

  // ── Multi-window convergence ───────────────────────────────────────

  it('should converge upward to maxConcurrency under no contention', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      maxConcurrency: 10,
      smoothingFactor: 1.0,
    });

    const concurrencies = [controller.getConcurrency()];

    // Run 5 probe windows, all at constant latency (gradient = 1)
    for (let window = 0; window < 5; window++) {
      for (let i = 0; i < 4; i++) {
        controller.recordCompletion(10);
      }
      concurrencies.push(controller.getConcurrency());
    }

    // Should grow monotonically
    for (let i = 1; i < concurrencies.length; i++) {
      expect(concurrencies[i]).toBeGreaterThanOrEqual(concurrencies[i - 1]);
    }
    // Should reach max
    expect(concurrencies[concurrencies.length - 1]).toBe(10);
  });

  it('should reduce and stabilize under sustained high latency', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      smoothingFactor: 1.0,
    });

    // First window: establish low baseline (minLatency = 10, EMA = 10)
    for (let i = 0; i < 4; i++) {
      controller.recordCompletion(10);
    }
    // gradient=1, c = 4+2 = 6
    expect(controller.getConcurrency()).toBe(6);

    // Latency spikes to 100ms (10× baseline) for several windows
    const concurrencies: number[] = [];
    for (let window = 0; window < 6; window++) {
      for (let i = 0; i < 4; i++) {
        controller.recordCompletion(100);
      }
      concurrencies.push(controller.getConcurrency());
    }

    // First adjustment should decrease sharply (gradient ≈ 10/100 = 0.1)
    expect(concurrencies[0]).toBeLessThan(6);

    // Should stabilize — last two values within 1 of each other
    const last = concurrencies[concurrencies.length - 1];
    const secondLast = concurrencies[concurrencies.length - 2];
    expect(Math.abs(last - secondLast)).toBeLessThanOrEqual(1);
  });

  // ── minLatency decay ───────────────────────────────────────────────

  it('should decay minLatency so an early outlier does not poison the baseline forever', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      maxConcurrency: 20,
      smoothingFactor: 1.0,
    });

    // One anomalously fast task followed by normal tasks
    controller.recordCompletion(1); // outlier
    controller.recordCompletion(50);
    controller.recordCompletion(50);
    controller.recordCompletion(50);

    // First probe: gradient = 1/50 = 0.02, heavy penalty.
    // Without decay, this outlier min=1 would stay forever.
    const afterFirst = controller.getConcurrency();

    // Run many more windows at steady 50ms latency
    for (let window = 0; window < 20; window++) {
      for (let i = 0; i < 4; i++) {
        controller.recordCompletion(50);
      }
    }

    // With decay, minLatency should have crept toward 50,
    // so gradient approaches 1 and concurrency should recover
    expect(controller.getConcurrency()).toBeGreaterThan(afterFirst);
  });

  it('stays numeric when every task completes in 0ms', () => {
    const controller = new AdaptiveController({ probeInterval: 4 });

    for (let i = 0; i < 40; i++) {
      controller.recordCompletion(0);
    }

    // A zero baseline and a zero EMA make the gradient 0/0. NaN would survive
    // clamping and then close the scheduler's concurrency gate permanently.
    expect(Number.isNaN(controller.getConcurrency())).toBe(false);
    expect(controller.getConcurrency()).toBeGreaterThanOrEqual(1);
  });

  it('treats zero latency as no contention and grows the limit', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
    });

    for (let i = 0; i < 4; i++) {
      controller.recordCompletion(0);
    }

    expect(controller.getConcurrency()).toBeGreaterThan(4);
  });

  describe('option validation', () => {
    it.each([
      ['maxConcurrency', { maxConcurrency: 0 }],
      ['maxConcurrency', { maxConcurrency: -5 }],
      ['maxConcurrency', { maxConcurrency: Number.NaN }],
      ['maxConcurrency', { maxConcurrency: Number.POSITIVE_INFINITY }],
      ['initialConcurrency', { initialConcurrency: 2.7 }],
      ['probeInterval', { probeInterval: 0 }],
      ['smoothingFactor', { smoothingFactor: 0 }],
      ['smoothingFactor', { smoothingFactor: 5 }],
      ['smoothingFactor', { smoothingFactor: -1 }],
    ])('rejects an out-of-range %s', (option, options) => {
      expect(() => new AdaptiveController(options)).toThrow(RangeError);
      expect(() => new AdaptiveController(options)).toThrow(option);
    });

    it('rejects a minimum above the maximum', () => {
      expect(
        () => new AdaptiveController({ minConcurrency: 100, maxConcurrency: 8 })
      ).toThrow(RangeError);
    });

    it('accepts the documented bounds', () => {
      const controller = new AdaptiveController({
        maxConcurrency: 16,
        minConcurrency: 2,
        initialConcurrency: 4,
        smoothingFactor: 1,
        probeInterval: 1,
      });

      expect(controller.getConcurrency()).toBe(4);
    });
  });
});
