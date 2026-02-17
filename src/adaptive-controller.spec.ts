import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptiveController } from './adaptive-controller.js';

describe('AdaptiveController', () => {
  let mockNow: number;

  beforeEach(() => {
    mockNow = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => mockNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use default concurrency', () => {
    const controller = new AdaptiveController();
    expect(controller.getConcurrency()).toBe(4);
  });

  it('should respect initialConcurrency option', () => {
    const controller = new AdaptiveController({ initialConcurrency: 10 });
    expect(controller.getConcurrency()).toBe(10);
  });

  it('should clamp initialConcurrency to bounds', () => {
    const controller = new AdaptiveController({
      initialConcurrency: 100,
      maxConcurrency: 16,
    });
    expect(controller.getConcurrency()).toBe(16);

    const controller2 = new AdaptiveController({
      initialConcurrency: 0,
      minConcurrency: 2,
    });
    expect(controller2.getConcurrency()).toBe(2);
  });

  it('should not adjust on first probe (no previous throughput)', () => {
    const controller = new AdaptiveController({
      probeInterval: 2,
      initialConcurrency: 4,
    });

    mockNow = 1100;
    controller.recordCompletion();
    controller.recordCompletion();

    expect(controller.getConcurrency()).toBe(4);
  });

  it('should increase concurrency when throughput improves', () => {
    const controller = new AdaptiveController({
      probeInterval: 2,
      initialConcurrency: 4,
      smoothingFactor: 1.0,
    });

    // First probe: baseline at lower throughput
    mockNow = 2000;
    controller.recordCompletion();
    controller.recordCompletion();

    // Second probe: higher throughput (same tasks in less time)
    mockNow = 2500;
    controller.recordCompletion();
    controller.recordCompletion();

    expect(controller.getConcurrency()).toBe(5);
  });

  it('should decrease concurrency when throughput degrades', () => {
    const controller = new AdaptiveController({
      probeInterval: 2,
      initialConcurrency: 4,
      smoothingFactor: 1.0,
    });

    // First probe: baseline at higher throughput
    mockNow = 1500;
    controller.recordCompletion();
    controller.recordCompletion();

    // Second probe: lower throughput (same tasks in more time)
    mockNow = 3500;
    controller.recordCompletion();
    controller.recordCompletion();

    expect(controller.getConcurrency()).toBe(3);
  });

  it('should not exceed maxConcurrency', () => {
    const controller = new AdaptiveController({
      probeInterval: 2,
      initialConcurrency: 4,
      maxConcurrency: 5,
      smoothingFactor: 1.0,
    });

    // First probe
    mockNow = 2000;
    controller.recordCompletion();
    controller.recordCompletion();

    // Increase once
    mockNow = 2500;
    controller.recordCompletion();
    controller.recordCompletion();
    expect(controller.getConcurrency()).toBe(5);

    // Try to increase again
    mockNow = 2750;
    controller.recordCompletion();
    controller.recordCompletion();
    expect(controller.getConcurrency()).toBe(5);
  });

  it('should not go below minConcurrency', () => {
    const controller = new AdaptiveController({
      probeInterval: 2,
      initialConcurrency: 2,
      minConcurrency: 2,
      smoothingFactor: 1.0,
    });

    // First probe: high throughput baseline
    mockNow = 1100;
    controller.recordCompletion();
    controller.recordCompletion();

    // Second probe: lower throughput
    mockNow = 3100;
    controller.recordCompletion();
    controller.recordCompletion();

    expect(controller.getConcurrency()).toBe(2);
  });

  it('should hold steady when throughput is constant', () => {
    const controller = new AdaptiveController({
      probeInterval: 2,
      initialConcurrency: 4,
      smoothingFactor: 1.0,
    });

    // First probe
    mockNow = 2000;
    controller.recordCompletion();
    controller.recordCompletion();

    // Same throughput
    mockNow = 3000;
    controller.recordCompletion();
    controller.recordCompletion();

    expect(controller.getConcurrency()).toBe(4);
  });

  it('should report correct stats', () => {
    const controller = new AdaptiveController({
      probeInterval: 2,
      initialConcurrency: 4,
      smoothingFactor: 1.0,
    });

    // Trigger two probes to get an adjustment
    mockNow = 2000;
    controller.recordCompletion();
    controller.recordCompletion();

    mockNow = 2500;
    controller.recordCompletion();
    controller.recordCompletion();

    const stats = controller.getStats(4, 1500);
    expect(stats.totalTasks).toBe(4);
    expect(stats.totalDurationMs).toBe(1500);
    expect(stats.peakConcurrency).toBe(5);
    expect(stats.adjustments).toBe(1);
    expect(stats.avgConcurrency).toBeGreaterThan(0);
  });

  it('should use EMA smoothing to dampen changes', () => {
    const controller = new AdaptiveController({
      probeInterval: 2,
      initialConcurrency: 4,
      smoothingFactor: 0.1,
    });

    // First probe: baseline
    mockNow = 2000;
    controller.recordCompletion();
    controller.recordCompletion();

    // Second probe: slightly better throughput, but with low smoothing
    // the EMA change is dampened
    mockNow = 2900;
    controller.recordCompletion();
    controller.recordCompletion();

    // With smoothing factor 0.1, the EMA is mostly the previous value
    // so gradient is still positive but small
    expect(controller.getConcurrency()).toBeGreaterThanOrEqual(4);
  });
});
