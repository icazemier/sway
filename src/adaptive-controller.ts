import { SwayOptions, SwayStats } from './interfaces.js';

const DEFAULT_MAX_CONCURRENCY = 64;
const DEFAULT_MIN_CONCURRENCY = 1;
const DEFAULT_INITIAL_CONCURRENCY = 4;
const DEFAULT_SMOOTHING_FACTOR = 0.3;
const DEFAULT_PROBE_INTERVAL = 8;

/**
 * Options arrive from callers, so TypeScript alone cannot keep them honest —
 * a value crossing a JavaScript boundary, a parsed config, or an `any` in a
 * consumer's code all reach here unchecked. A non-finite or fractional bound
 * silently corrupts every later calculation, so it is rejected at the edge
 * where the caller can still see which option was wrong.
 */
function requirePositiveInteger(
  option: string,
  value: number | undefined,
  fallback: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      `${option} must be a positive integer, received ${String(value)}`
    );
  }
  return value;
}

function requireRatio(
  option: string,
  value: number | undefined,
  fallback: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RangeError(
      `${option} must be greater than 0 and at most 1, received ${String(value)}`
    );
  }
  return value;
}

/**
 * Latency-gradient concurrency controller inspired by
 * {@link https://en.wikipedia.org/wiki/TCP_Vegas | TCP Vegas} and
 * {@link https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581 | Netflix's adaptive concurrency limiter}.
 *
 * Latency is a leading indicator of contention — it rises immediately
 * when concurrency exceeds optimal, before throughput drops. The controller
 * tracks a learned minimum latency (no-contention baseline) and an EMA of
 * recent latencies, then computes a gradient that steers concurrency
 * toward equilibrium:
 *
 * ```
 * gradient  = minLatency / smoothedLatency
 * newLimit  = concurrency × gradient + √concurrency
 * ```
 *
 * The minimum latency baseline slowly decays toward the EMA so that a
 * single anomalously-fast task cannot permanently poison the gradient.
 *
 * @example
 * ```ts
 * const controller = new AdaptiveController({ maxConcurrency: 16 });
 * controller.getConcurrency(); // 4 (default initial)
 * controller.recordCompletion(12.5); // task took 12.5ms
 * ```
 */
export class AdaptiveController {
  private concurrency: number;
  private readonly maxConcurrency: number;
  private readonly minConcurrency: number;
  private readonly smoothingFactor: number;
  private readonly probeInterval: number;

  private completionsSinceLastProbe = 0;
  private minLatency: number | null = null;
  private latencyEma: number | null = null;
  private peakConcurrency: number;
  private concurrencySum = 0;
  private concurrencySamples = 0;
  private adjustmentCount = 0;

  /**
   * @param options - Tuning knobs for the controller (all optional)
   * @throws RangeError - If any option is outside the range it documents
   */
  constructor(options?: SwayOptions) {
    this.maxConcurrency = requirePositiveInteger(
      'maxConcurrency',
      options?.maxConcurrency,
      DEFAULT_MAX_CONCURRENCY
    );
    this.minConcurrency = requirePositiveInteger(
      'minConcurrency',
      options?.minConcurrency,
      DEFAULT_MIN_CONCURRENCY
    );
    this.probeInterval = requirePositiveInteger(
      'probeInterval',
      options?.probeInterval,
      DEFAULT_PROBE_INTERVAL
    );
    this.smoothingFactor = requireRatio(
      'smoothingFactor',
      options?.smoothingFactor,
      DEFAULT_SMOOTHING_FACTOR
    );

    if (this.minConcurrency > this.maxConcurrency) {
      throw new RangeError(
        `minConcurrency (${this.minConcurrency}) must not exceed maxConcurrency (${this.maxConcurrency})`
      );
    }

    this.concurrency = this.clamp(
      requirePositiveInteger(
        'initialConcurrency',
        options?.initialConcurrency,
        DEFAULT_INITIAL_CONCURRENCY
      )
    );
    this.peakConcurrency = this.concurrency;
  }

  /**
   * Signal that a task has completed with the given duration.
   * Updates latency tracking and triggers a probe when enough
   * completions have accumulated.
   *
   * @param durationMs - How long the task took in milliseconds
   */
  recordCompletion(durationMs: number): void {
    // Update min latency (learned baseline)
    if (this.minLatency === null || durationMs < this.minLatency) {
      this.minLatency = durationMs;
    }

    // Update latency EMA
    if (this.latencyEma === null) {
      this.latencyEma = durationMs;
    } else {
      this.latencyEma =
        this.smoothingFactor * durationMs +
        (1 - this.smoothingFactor) * this.latencyEma;
    }

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
    // Both are guaranteed non-null: recordCompletion() sets them before calling probe()
    const minLat = this.minLatency;
    const emaLat = this.latencyEma;
    if (minLat === null || emaLat === null) return;

    // Tasks fast enough to measure as 0ms drag both the baseline and the EMA
    // to zero, and 0/0 is NaN. NaN fails every comparison, so it would survive
    // clamping and then permanently close the scheduler's concurrency gate.
    // No measurable latency means no contention, so the gradient is neutral
    // and the limit still grows by the probe term.
    const gradient = emaLat > 0 ? minLat / emaLat : 1;
    const newLimit = this.concurrency * gradient + Math.sqrt(this.concurrency);
    this.setConcurrency(Math.round(newLimit));

    // Decay minLatency toward EMA so a single anomalously-fast task
    // doesn't permanently poison the baseline
    this.minLatency = minLat + (emaLat - minLat) * 0.05;

    this.completionsSinceLastProbe = 0;
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
    // Math.max/Math.min propagate NaN rather than clamping it, which would let
    // a non-numeric limit reach the scheduler and stall it. Infinities clamp
    // to the bounds normally.
    if (Number.isNaN(value)) return this.concurrency;
    return Math.max(this.minConcurrency, Math.min(this.maxConcurrency, value));
  }
}
