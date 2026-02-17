import { SwayOptions, SwayStats } from './interfaces.js';

const DEFAULT_MAX_CONCURRENCY = 64;
const DEFAULT_MIN_CONCURRENCY = 1;
const DEFAULT_INITIAL_CONCURRENCY = 4;
const DEFAULT_SMOOTHING_FACTOR = 0.3;
const DEFAULT_PROBE_INTERVAL = 8;

/**
 * Gradient-based concurrency controller.
 *
 * Measures throughput via an exponential moving average (EMA) and adjusts the
 * concurrency level to maximise task completion speed. The controller probes
 * every {@link SwayOptions.probeInterval | probeInterval} completed tasks,
 * compares the current EMA throughput against the previous one, and nudges
 * concurrency up or down by one depending on the gradient direction.
 *
 * @example
 * ```ts
 * const controller = new AdaptiveController({ maxConcurrency: 16 });
 * controller.getConcurrency(); // 4 (default initial)
 * controller.recordCompletion();
 * ```
 */
export class AdaptiveController {
  private concurrency: number;
  private readonly maxConcurrency: number;
  private readonly minConcurrency: number;
  private readonly smoothingFactor: number;
  private readonly probeInterval: number;

  private completionsSinceLastProbe = 0;
  private emaThroughput: number | null = null;
  private previousEmaThroughput: number | null = null;
  private lastProbeTime: number;
  private peakConcurrency: number;
  private concurrencySum = 0;
  private concurrencySamples = 0;
  private adjustmentCount = 0;

  /**
   * @param options - Tuning knobs for the controller (all optional)
   */
  constructor(options?: SwayOptions) {
    this.maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.minConcurrency = options?.minConcurrency ?? DEFAULT_MIN_CONCURRENCY;
    this.concurrency =
      options?.initialConcurrency ?? DEFAULT_INITIAL_CONCURRENCY;
    this.smoothingFactor = options?.smoothingFactor ?? DEFAULT_SMOOTHING_FACTOR;
    this.probeInterval = options?.probeInterval ?? DEFAULT_PROBE_INTERVAL;

    this.concurrency = this.clamp(this.concurrency);
    this.peakConcurrency = this.concurrency;
    this.lastProbeTime = performance.now();
  }

  /**
   * Signal that a task has completed. Triggers a probe when
   * {@link SwayOptions.probeInterval | probeInterval} completions have accumulated.
   */
  recordCompletion(): void {
    this.completionsSinceLastProbe++;
    this.concurrencySum += this.concurrency;
    this.concurrencySamples++;

    if (this.completionsSinceLastProbe >= this.probeInterval) {
      this.probe();
    }
  }

  /** Returns the current concurrency level. */
  getConcurrency(): number {
    return this.concurrency;
  }

  /**
   * Build a {@link SwayStats} snapshot.
   *
   * @param totalTasks - Total tasks executed
   * @param totalDurationMs - Wall-clock duration of the run in milliseconds
   * @returns Performance telemetry
   */
  getStats(totalTasks: number, totalDurationMs: number): SwayStats {
    return {
      totalTasks,
      totalDurationMs,
      peakConcurrency: this.peakConcurrency,
      avgConcurrency:
        this.concurrencySamples > 0
          ? this.concurrencySum / this.concurrencySamples
          : this.concurrency,
      adjustments: this.adjustmentCount,
    };
  }

  private probe(): void {
    const now = performance.now();
    const elapsed = now - this.lastProbeTime;

    if (elapsed <= 0) {
      this.completionsSinceLastProbe = 0;
      this.lastProbeTime = now;
      return;
    }

    const currentThroughput = this.completionsSinceLastProbe / (elapsed / 1000);

    if (this.emaThroughput === null) {
      this.emaThroughput = currentThroughput;
    } else {
      this.emaThroughput =
        this.smoothingFactor * currentThroughput +
        (1 - this.smoothingFactor) * this.emaThroughput;
    }

    if (this.previousEmaThroughput !== null) {
      const gradient = this.emaThroughput - this.previousEmaThroughput;

      if (gradient > 0) {
        this.setConcurrency(this.concurrency + 1);
      } else if (gradient < 0) {
        this.setConcurrency(this.concurrency - 1);
      }
    }

    this.previousEmaThroughput = this.emaThroughput;
    this.completionsSinceLastProbe = 0;
    this.lastProbeTime = now;
  }

  private setConcurrency(value: number): void {
    const clamped = this.clamp(value);
    if (clamped !== this.concurrency) {
      this.concurrency = clamped;
      this.adjustmentCount++;
      if (this.concurrency > this.peakConcurrency) {
        this.peakConcurrency = this.concurrency;
      }
    }
  }

  private clamp(value: number): number {
    return Math.max(this.minConcurrency, Math.min(this.maxConcurrency, value));
  }
}
