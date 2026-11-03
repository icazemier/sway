import { describe, it, expect } from 'vitest';
import { AdaptiveController } from './adaptive-controller.js';
import { runQueuingSim } from './queuing-sim.js';

// Verification options used by the queuing overshoot tests — match the
// production default tuning knobs.
const VERIFY_OPTIONS = {
  maxConcurrency: 64,
  minConcurrency: 1,
  initialConcurrency: 4,
  probeInterval: 8,
  smoothingFactor: 0.3,
  probeMultiplier: 30,
} as const;

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

  // ── Netflix VegasLimit behaviour ───────────────────────────────────

  it('should increase concurrency when latency stays at the no-load baseline', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      smoothingFactor: 1.0,
    });

    // All tasks at the same latency → queueSize = ceil(4 × (1 − 10/10)) = 0.
    // queueSize ≤ threshold(0) → aggressive increase by max(1, beta=1) = 1 → 5.
    for (let i = 0; i < 4; i++) {
      controller.recordCompletion(10);
    }
    expect(controller.getConcurrency()).toBe(5);
  });

  it('should decrease concurrency when latency shows queuing', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 10,
      smoothingFactor: 1.0,
    });

    // First completion sets minLatency = 10.
    controller.recordCompletion(10);

    // Next 3 at high latency (50ms) → latencyEma = 50.
    // queueSize = ceil(10 × (1 − 10/50)) = 8 > beta(max(0, 2)) = 2 → decrease
    // by log10Root(10) = 1 → 9. Decreases bypass smoothing.
    for (let i = 0; i < 3; i++) {
      controller.recordCompletion(50);
    }
    expect(controller.getConcurrency()).toBe(9);
  });

  it('should track minLatency as the lowest observed duration', () => {
    const controller = new AdaptiveController({
      probeInterval: 8,
      initialConcurrency: 4,
      smoothingFactor: 1.0,
    });

    // Record various latencies — min should be learned as 5.
    controller.recordCompletion(20);
    controller.recordCompletion(5); // new minimum
    controller.recordCompletion(15);
    controller.recordCompletion(10);

    // After 4 completions (less than probeInterval=8), no adjustment yet.
    expect(controller.getConcurrency()).toBe(4);

    // Fill remaining window with latency = 5 (matching min).
    // latencyEma = 5, queueSize = ceil(4 × (1 − 5/5)) = 0 → aggressive
    // increase by max(1, beta=1) = 1 → 5.
    for (let i = 0; i < 4; i++) {
      controller.recordCompletion(5);
    }
    expect(controller.getConcurrency()).toBe(5);
  });

  // ── Clamping ───────────────────────────────────────────────────────

  it('should not exceed maxConcurrency', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      maxConcurrency: 5,
      smoothingFactor: 1.0,
    });

    // queueSize = 0 → increase by max(1, beta=1) = 1 → 5, clamped to 5.
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

    // First at low latency sets minLatency = 1.
    controller.recordCompletion(1);

    // Rest at very high latency → queueSize = ceil(4 × (1 − 1/1000)) = 4 >
    // beta(0) → decrease by 1 → 3, clamped to minConcurrency = 3.
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

    // One probe window at constant latency → increases to 5.
    for (let i = 0; i < 4; i++) {
      controller.recordCompletion(10);
    }
    expect(controller.getConcurrency()).toBe(5);

    const stats = controller.getStats(4, 300);
    expect(stats.totalTasks).toBe(4);
    expect(stats.totalDurationMs).toBe(300);
    expect(stats.peakConcurrency).toBe(5);
    expect(stats.adjustments).toBe(1);
    // All 4 samples recorded at concurrency 4 (adjustment happened at the end).
    expect(stats.avgConcurrency).toBe(4);
  });

  // ── Smoothing ──────────────────────────────────────────────────────

  it('should use EMA smoothing to dampen the latency signal', () => {
    // smoothingFactor governs the latency EMA: a higher value tracks the
    // latest sample more eagerly (so a latency spike raises the EMA toward it
    // faster), a lower value averages more heavily. Limit adjustments are
    // decisive integer steps, so the option's effect is on queue-size
    // estimation, not on the adjustment magnitude.
    const eager = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 10,
      smoothingFactor: 1.0, // EMA = latest sample
    });

    const calm = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 10,
      smoothingFactor: 0.1, // heavy averaging
    });

    // Establish a low baseline (no-load latency 10), then one high sample.
    // recordCompletion keeps the monotonic-lower baseline at 10 but the EMA
    // moves: eager EMA = 10 (1.0×), calm EMA = 0.9×10 + 0.1×100 = 19.
    for (let i = 0; i < 4; i++) {
      eager.recordCompletion(10);
      calm.recordCompletion(10);
    }
    eager.recordCompletion(100);
    calm.recordCompletion(100);

    // The eager EMA tracked the spike; the calm EMA stayed well below it.
    expect(eager.getLatencyEma()).toBe(100);
    expect(calm.getLatencyEma()).toBeLessThan(40);
  });

  // ── Multi-window convergence ───────────────────────────────────────

  it('should converge upward to maxConcurrency under no contention', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      maxConcurrency: 10,
      smoothingFactor: 1.0,
    });

    // Under no contention latency stays at the baseline, queueSize = 0, so the
    // controller aggressive-increases by max(1, beta) each window until it
    // reaches maxConcurrency.
    for (let window = 0; window < 8; window++) {
      for (let i = 0; i < 4; i++) {
        controller.recordCompletion(10);
      }
    }

    expect(controller.getConcurrency()).toBe(10);
  });

  it('should reduce and stabilize under sustained high latency', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      smoothingFactor: 1.0,
    });

    // First window: establish low baseline (minLatency = 10, EMA = 10).
    for (let i = 0; i < 4; i++) {
      controller.recordCompletion(10);
    }
    // queueSize = 0 → increase by max(1, beta=1) = 1 → 5.
    expect(controller.getConcurrency()).toBe(5);

    // Latency spikes to 100ms (10× baseline) for several windows: queueSize
    // exceeds beta every step, so the controller pulls back decisively each
    // window until it bottoms out at minConcurrency.
    const concurrencies: number[] = [];
    for (let window = 0; window < 6; window++) {
      for (let i = 0; i < 4; i++) {
        controller.recordCompletion(100);
      }
      concurrencies.push(controller.getConcurrency());
    }

    // First adjustment should decrease below the pre-spike level.
    expect(concurrencies[0]).toBeLessThan(5);

    // Should stabilize — last two values within 1 of each other.
    const last = concurrencies[concurrencies.length - 1];
    const secondLast = concurrencies[concurrencies.length - 2];
    expect(Math.abs(last - secondLast)).toBeLessThanOrEqual(1);
  });

  // ── Re-probe recovery ──────────────────────────────────────────────

  it('should refresh a stale baseline via re-probe, not decay', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      maxConcurrency: 20,
      smoothingFactor: 1.0,
      // probeCount now increments per completion, so a mid-size multiplier
      // lets the first window pull back before the re-probe fires, then
      // recovers the baseline over the run's ~120 completions.
      probeMultiplier: 10,
    });

    // One anomalously fast task poisons the stable baseline, then normal tasks.
    controller.recordCompletion(1); // outlier
    controller.recordCompletion(50);
    controller.recordCompletion(50);
    controller.recordCompletion(50);
    // minLatency = 1, latencyEma = 50 → heavy queuing signal → pull back.
    const afterOutlier = controller.getConcurrency();
    expect(afterOutlier).toBeLessThan(4);

    // The stable baseline (1ms) is not decayed toward the EMA; it is only
    // refreshed by a periodic re-probe. Run enough windows that the re-probe
    // fires, resetting minLatency = latencyEma = 50, after which queueSize = 0
    // and the controller climbs back.
    for (let window = 0; window < 30; window++) {
      for (let i = 0; i < 4; i++) {
        controller.recordCompletion(50);
      }
    }

    // Re-probe recovered the baseline → concurrency grew back above the
    // outlier-pinned low point.
    expect(controller.getConcurrency()).toBeGreaterThan(afterOutlier);
  });

  it('stays numeric when every task completes in 0ms', () => {
    const controller = new AdaptiveController({ probeInterval: 4 });

    for (let i = 0; i < 40; i++) {
      controller.recordCompletion(0);
    }

    // A zero baseline and a zero EMA would make queueSize 0/0 → NaN. The
    // controller guards it (treats zero latency as no queuing), so the limit
    // stays numeric and never closes the scheduler's concurrency gate.
    expect(Number.isNaN(controller.getConcurrency())).toBe(false);
    expect(controller.getConcurrency()).toBeGreaterThanOrEqual(1);
  });

  it('treats zero latency as no contention and grows the limit', () => {
    const controller = new AdaptiveController({
      probeInterval: 4,
      initialConcurrency: 4,
      smoothingFactor: 1.0,
    });

    for (let i = 0; i < 4; i++) {
      controller.recordCompletion(0);
    }

    // emaLat = 0 → queueSize treated as 0 → aggressive increase → 5.
    expect(controller.getConcurrency()).toBeGreaterThan(4);
  });

  // ── Deterministic queuing overshoot (capacity 1 and 4) ─────────────

  it('holds near the optimum on a capacity-1 queuing resource', () => {
    const controller = new AdaptiveController({ ...VERIFY_OPTIONS });

    // A semaphore with a single slot: optimum concurrency is 1. Overshoot
    // queues tasks FIFO and inflates their latency to a clear decrease signal.
    const result = runQueuingSim(
      controller,
      /* capacity */ 1,
      /* service */ 10,
      3000
    );

    // Converges down to the optimum: average concurrency ≈ 1, and it holds
    // there for the tail of the run (no re-inflation).
    expect(result.avgConcurrency).toBeLessThan(1.5);
    // Peak is bounded (user decision 2026-10-25: allow bounded overshoot, peak
    // ≤ 8) — the controller may probe up briefly to confirm the sweet spot but
    // must not park or climb above it.
    expect(result.peakConcurrency).toBeLessThanOrEqual(8);
  });

  it('holds near the optimum on a capacity-4 queuing resource', () => {
    const controller = new AdaptiveController({ ...VERIFY_OPTIONS });

    // A semaphore with four slots: optimum concurrency is 4. The controller
    // should settle at 4 without overshooting.
    const result = runQueuingSim(
      controller,
      /* capacity */ 4,
      /* service */ 10,
      3000
    );

    // Average concurrency stays ≈ 4 (the optimum) — no climb toward the
    // maxConcurrency ceiling as the old gradient model did.
    expect(result.avgConcurrency).toBeGreaterThanOrEqual(3.5);
    expect(result.avgConcurrency).toBeLessThanOrEqual(4.5);
    // Peak is bounded (user decision 2026-10-25: allow bounded overshoot, peak
    // ≤ 6) — the controller may probe up one step to confirm the sweet spot
    // before settling.
    expect(result.peakConcurrency).toBeLessThanOrEqual(6);
  });

  it('grows from the minimum when started at initialConcurrency=1', () => {
    // Regression: at concurrency 1, the anti-drift guard (`inflight * 2 <
    // concurrency`) always holds when `inflight` excludes the completing task,
    // because it is 0 after decrement. The controller must instead count the
    // completing task (Netflix `getActiveCount()`) so a controller at the
    // minimum can still probe up toward the optimum.
    const controller = new AdaptiveController({
      ...VERIFY_OPTIONS,
      initialConcurrency: 1,
      minConcurrency: 1,
    });

    const result = runQueuingSim(
      controller,
      /* capacity */ 4,
      /* service */ 10,
      3000
    );

    // It must leave 1 and reach the capacity-4 optimum.
    expect(result.avgConcurrency).toBeGreaterThan(1.5);
    expect(result.avgConcurrency).toBeGreaterThanOrEqual(3.0);
    expect(result.avgConcurrency).toBeLessThanOrEqual(4.5);
  });

  describe('option validation', () => {
    it.each([
      ['maxConcurrency', { maxConcurrency: 0 }],
      ['maxConcurrency', { maxConcurrency: -5 }],
      ['maxConcurrency', { maxConcurrency: Number.NaN }],
      ['maxConcurrency', { maxConcurrency: Number.POSITIVE_INFINITY }],
      ['initialConcurrency', { initialConcurrency: 2.7 }],
      ['probeInterval', { probeInterval: 0 }],
      ['probeMultiplier', { probeMultiplier: 0 }],
      ['probeMultiplier', { probeMultiplier: -5 }],
      ['probeMultiplier', { probeMultiplier: Number.NaN }],
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
        probeMultiplier: 30,
      });

      expect(controller.getConcurrency()).toBe(4);
    });
  });
});
