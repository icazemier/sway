import { SwayOptions, SwayStats } from './interfaces.js';

const DEFAULT_MAX_CONCURRENCY = 64;
const DEFAULT_MIN_CONCURRENCY = 1;
const DEFAULT_INITIAL_CONCURRENCY = 4;
const DEFAULT_SMOOTHING_FACTOR = 0.3;
const DEFAULT_PROBE_INTERVAL = 8;
const DEFAULT_PROBE_MULTIPLIER = 30;

/**
 * Jitter dead-zone for latency-ratio queuing detection.
 *
 * `queueSize` is estimated from `concurrency × (1 − minLatency / emaLat)`, where
 * `minLatency` is the strict no-load floor. On a noisy-but-healthy resource the
 * EMA naturally sits a few percent above that floor (additive jitter is always
 * ≥ the base service time), so a tiny ratio like `1.1` is measurement noise, not
 * queuing — but at small limits that ratio still yields `queueSize = 1`, which a
 * tight `threshold = 5%·limit` reads as real queuing and spirals the limit down.
 *
 * We treat any latency inflation below this ratio as jitter noise (no queuing,
 * `queueSize = 0`) and only start estimating a queue once inflation exceeds it.
 * Real queuing always pushes latency well beyond jitter range: even one task
 * waiting behind a full slot waits at least one extra service time, so the ratio
 * is ≥ 2 at the tail. `1.15` sits above typical jitter (≈1.1) and below the
 * mild-queuing signal of a one-step overshoot on a deterministic resource
 * (ratio ≈1.18), so genuine small queues still trigger a decrease.
 */
const MIN_QUEUING_RATIO = 1.15;

/**
 * Size of the rolling latency window used to derive the no-load baseline.
 * Large enough to smooth per-sample jitter, small enough to flush an
 * overshoot penalty once latency returns to normal.
 */
const BASELINE_WINDOW_SIZE = 64;

/**
 * Percentile of the recent latency window used as the no-load baseline.
 *
 * Netflix's `rtt_noload` is the absolute minimum, which is exact on a
 * deterministic resource but reads the low tail of jitter as a floor on a
 * noisy one — leaving the mean-vs-min gap (~15-20% on a 20%-jitter resource)
 * indistinguishable from a genuine mild overshoot and spiralling the limit
 * down. Using a low percentile (P25) instead: on a deterministic resource
 * the baseline is still exactly the floor (no jitter to skew it), while on a
 * jittery resource the baseline sits slightly above the absolute min so the
 * healthy operating ratio clears the dead-zone cleanly.
 */
const BASELINE_PERCENTILE = 0.25;

/**
 * NetFlix `Log10RootIntFunction`:
 * `LOG10(limit) = max(1, floor(log10(limit)))` — the concurrency step size.
 *
 * Returns 1 for limits 1-99, 2 for 100-999, 3 for 1000+, etc. It is the
 * "root" the controller climbs down by on each decrease, matching
 * {@link https://github.com/Netflix/concurrency-limits/blob/master/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limit/function/Log10RootIntFunction.java | Log10RootIntFunction}.
 */
function log10Root(limit: number): number {
  return Math.max(1, Math.floor(Math.log10(Math.max(1, limit))));
}

/**
 * Latency-queue concurrency controller faithful to Netflix's
 * {@link https://github.com/Netflix/concurrency-limits/blob/master/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limit/VegasLimit.java | VegasLimit}.
 *
 * Latency is a leading indicator of contention — it rises immediately
 * when concurrency exceeds the sweet spot, because excess tasks queue.
 * The controller tracks a stable no-load latency baseline (`minLatency`,
 * equivalent to Netflix's `rtt_noload`) and an EMA of recent latencies,
 * then estimates how many requests are queued behind the resource:
 *
 * ```
 * queueSize = ceil(concurrency × (1 − minLatency / latencyEma))
 * ```
 *
 * The baseline is a **low percentile of a rolling window** of recent
 * latencies: it stays stable and exact on deterministic resources while
 * recovering after overshoots on jittery ones. (A strict monotonic minimum —
 * Netflix's `rtt_noload` — would cling to the absolute low tail of a jitter
 * distribution, leaving a permanent gap to the mean that reads as false
 * queuing and spirals the limit down.)
 *
 * Decision bands are **proportional** (Netflix's documented intent, see
 * the `VegasLimit` class Javadoc: `alpha = Max(3, 10%)`, `beta = Max(6, 20%)`),
 * floored so that any queuing at tiny limits triggers a decrease:
 *
 * ```
 * threshold = max(0, round(0.05 × limit))   // ≤ this → aggressive increase
 * alpha     = max(1, round(0.10 × limit))   // <  this → slow increase
 * beta      = max(1, floor(0.10 × limit))   // >  this → decrease
 * ```
 *
 * The `queueSize` estimate passes through a **jitter dead-zone**
 * (`MIN_QUEUING_RATIO = 1.15`): latency inflation up to 1.15× the no-load floor
 * is treated as measurement noise, not queuing. The low-percentile baseline
 * already cancels most jitter variance, so on a noisy-but-healthy resource the
 * ratio clears the dead-zone cleanly; a tight `threshold = 5%·limit` no longer
 * reads jitter as `queueSize = 1` and collapses the limit. Real queuing — a task
 * waiting behind a full slot — inflates latency past the dead-zone, so genuine
 * contention still triggers a decrease.
 *
 * The `beta` floor is **1**, so a single queued request (`queueSize = 1`) at
 * limits 1-4 is caught by the `hasQueuing` signal rather than the size bands.
 *
 * Every `probeInterval` completions the controller either increases
 * (aggressively below `threshold`, slowly below `alpha`), decreases
 * (`queueSize > beta`), or holds (sweet spot). Periodically — after roughly
 * `jitter × probeMultiplier × concurrency` completions — it re-probes,
 * refreshing the baseline so capacity growth is detected and the controller
 * does not get stuck too low.
 *
 * @example
 * ```ts
 * const controller = new AdaptiveController({ maxConcurrency: 16 });
 * controller.getConcurrency(); // 4 (default initial)
 * controller.recordCompletion(12.5); // task took 12.5ms
 * controller.getLatencyEma(); // current EMA of observed latencies
 * ```
 */
export class AdaptiveController {
  private concurrency: number;
  private readonly maxConcurrency: number;
  private readonly minConcurrency: number;
  private readonly smoothingFactor: number;
  private readonly probeInterval: number;
  private readonly probeMultiplier: number;

  private completionsSinceLastProbe = 0;
  private minLatency: number | null = null;
  private latencyEma: number | null = null;
  /**
   * Rolling window of recent latency samples used to derive a recoverable
   * no-load baseline. Unlike Netflix's strict monotonic `rtt_noload` — which
   * clings to the absolute lowest sample and never recovers — the baseline
   * here is the low percentile of a recent window, so on a jittery resource
   * it tracks the current operating floor and recovers after an overshoot
   * spike instead of leaving a stale inflated latency ratio behind.
   */
  private readonly latencyWindow: number[] = [];
  private readonly latencyWindowSize: number;
  private readonly baselinePercentile: number;
  private peakConcurrency: number;
  private concurrencySum = 0;
  private concurrencySamples = 0;
  private adjustmentCount = 0;

  // Re-probe state
  private probeCount = 0;
  private probeJitter = 0;

  // Hysteresis: once the controller finds the latency wall (sweet spot), it
  // stops aggressive probing up until the next re-probe refreshes the
  // baseline. Without this, latency jitter that pushes queueSize to 0 would
  // trigger a `+beta` jump on every probe, keeping the limit a step above
  // the optimum (Netflix oscillates exactly this way; we settle instead).
  private settled = false;

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
    this.probeMultiplier = requirePositiveInteger(
      'probeMultiplier',
      options?.probeMultiplier,
      DEFAULT_PROBE_MULTIPLIER
    );

    this.latencyWindowSize = BASELINE_WINDOW_SIZE;
    this.baselinePercentile = BASELINE_PERCENTILE;

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
    this.resetProbeJitter();
  }

  /**
   * Signal that a task has completed with the given duration.
   *
   * Optionally the caller may pass the number of tasks still in flight at the
   * moment of completion (`inflight`, excluding this one) and whether the
   * task was dropped / timed out (`didDrop`). These mirror the `inflight` and
   * `didDrop` arguments of Netflix's `VegasLimit._update`:
   * - `didDrop` forces a decisive decrease — a timeout is a strong latency
   *   signal that concurrency is too high, so the controller backs off
   *   regardless of the measured queue size.
   * - When actual in-flight load is less than half the limit
   *   (`inflight * 2 < concurrency`), the controller **holds** instead of
   *   probing up. This prevents it chasing phantom headroom during lulls in
   *   bursty/irregular traffic (the case a PID controller cannot handle) — if
   *   there isn't enough real load to fill the limit, raising it is pointless.
   *
   * When omitted, `inflight` defaults to the current limit and `didDrop` to
   * `false`, which is the fully-saturated steady-state assumption used by the
   * deterministic queuing sim and the unit tests.
   *
   * @param durationMs - How long the task took in milliseconds
   * @param inflight - Tasks still in flight after this one completed
   * @param didDrop - Whether the task was dropped or timed out
   */
  recordCompletion(
    durationMs: number,
    inflight?: number,
    didDrop?: boolean
  ): void {
    // Recoverable low-percentile baseline. Rather than a strict monotonic
    // minimum (Netflix `rtt_noload`), the no-load reference is the low
    // percentile of a rolling window of recent latencies. This keeps the
    // baseline exact on deterministic resources (no jitter → percentile ==
    // floor) while letting it recover on jittery/overshoot resources, so a
    // stale spike doesn't leave a permanently inflated latency ratio.
    this.latencyWindow.push(durationMs);
    if (this.latencyWindow.length > this.latencyWindowSize) {
      this.latencyWindow.shift();
    }
    if (this.minLatency === null || durationMs < this.minLatency) {
      this.minLatency = durationMs;
    } else if (this.latencyWindow.length >= this.latencyWindowSize) {
      // Re-anchor to the current window's low percentile once the window is
      // warm, allowing recovery after an overshoot rather than clinging to a
      // stale absolute minimum forever.
      const sorted = [...this.latencyWindow].sort((a, b) => a - b);
      const idx = Math.floor(
        this.baselinePercentile * (sorted.length - 1)
      );
      const percentile = sorted[idx];
      if (percentile > this.minLatency) {
        this.minLatency = percentile;
      }
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
      this.probe(inflight, didDrop);
    }
  }

  /** Returns the current concurrency level. */
  getConcurrency(): number {
    return this.concurrency;
  }

  /**
   * Returns the current latency EMA (exponential moving average).
   * This is the smoothed latency signal used to estimate queue size.
   */
  getLatencyEma(): number {
    // Latency EMA is guaranteed non-null: recordCompletion() sets it on first call
    return this.latencyEma ?? 0;
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

  private probe(inflight?: number, didDrop?: boolean): void {
    // Both are guaranteed non-null: recordCompletion() sets them before calling probe()
    const minLat = this.minLatency;
    const emaLat = this.latencyEma;
    if (minLat === null || emaLat === null) return;

    this.probeCount++;

    // ── Re-probe ───────────────────────────────────────────────────────
    // After roughly `jitter × probeMultiplier × concurrency` completions,
    // refresh the baseline to the current latency and hold the limit. This
    // lets the controller notice capacity growth (or a genuinely faster
    // regime) instead of getting stuck at a stale no-load baseline. It also
    // re-arms the ability to probe up (clears `settled`) so a re-probe can
    // rediscover a higher sweet spot after the baseline has moved.
    if (
      this.probeJitter * this.probeMultiplier * this.concurrency <=
      this.probeCount
    ) {
      this.minLatency = emaLat;
      this.resetProbeJitter();
      this.probeCount = 0;
      this.completionsSinceLastProbe = 0;
      this.settled = false;
      return;
    }

    // ── Drop back-off ──────────────────────────────────────────────────
    // A dropped/timed-out request is the strongest latency signal: back off
    // decisively regardless of the measured queue size (Netflix `didDrop`).
    if (didDrop) {
      this.setConcurrency(
        this.clamp(this.concurrency - log10Root(this.concurrency))
      );
      this.completionsSinceLastProbe = 0;
      return;
    }

    // ── Anti-drift guard ───────────────────────────────────────────────
    // Netflix: "Prevent upward drift if not close to the limit." When the
    // actual number of in-flight tasks is less than half the limit, there is
    // not enough real load to justify a higher limit — hold instead of
    // chasing phantom headroom. This is what makes sway safe on irregular,
    // bursty throughput (the case a PID controller cannot handle): a lull
    // that drops inflight well below the limit must NOT be read as headroom.
    // Default (no inflight passed) assumes the fully-saturated steady state
    // where inflight == limit, so the guard never fires.
    const inFlight = inflight ?? this.concurrency;
    if (inFlight * 2 < this.concurrency) {
      this.completionsSinceLastProbe = 0;
      return;
    }

    // ── Decision ───────────────────────────────────────────────────────
    // Latency ratio vs the no-load floor. Zero measured latency means no
    // contention (0/0 would be NaN → treated as no queuing below). Otherwise
    // estimate queued requests as the excess of current concurrency beyond
    // what the no-load baseline implies.
    const ratio = minLat > 0 ? emaLat / minLat : emaLat > 0 ? Infinity : 0;
    // Jitter dead-zone (see MIN_QUEUING_RATIO): inflation within the noise
    // floor is not queuing. Only once the ratio clears the dead-zone do we
    // start estimating a queue — this is what stops noisy-but-healthy
    // resources from collapsing to concurrency 1 on a spurious `queueSize=1`.
    const contending = ratio >= MIN_QUEUING_RATIO;
    const queueSize =
      contending && emaLat > 0
        ? Math.ceil(this.concurrency * (1 - minLat / emaLat))
        : 0;

    const threshold = Math.max(0, Math.round(0.05 * this.concurrency));
    const alpha = Math.max(1, Math.round(0.1 * this.concurrency));
    // Use floor(10%) for beta, clamped to at least 1 to avoid false positives.
    // This ensures we don't decrease on tiny EMA variations (queueSize=1).
    // For tiny limits (4-5), this gives beta=1, which is still aggressive enough
    // to prevent overshoot while avoiding undershoot.
    const rawBeta = Math.floor(0.1 * this.concurrency);
    const beta = Math.max(1, rawBeta);
    const step = log10Root(this.concurrency);

    // Extra queuing check: if the EMA is inflated past the jitter dead-zone,
    // treat it as queuing even if queueSize <= beta. This catches cases where
    // the EMA has picked up queuing signal but the queueSize calculation gives
    // a low value (e.g. capacity-1 overshoot where queueSize=1 but beta=1).
    const hasQueuing = contending;

    let newLimit: number;
    // All adjustments are decisive (bypass smoothing). Netflix smooths both
    // increases and decreases, but our limit is an integer (Netflix keeps a
    // float and only rounds at dispatch): smoothing a 1-unit move through
    // `smoothingFactor` then rounding erases it entirely. At tiny limits a
    // `+1` increase would be swallowed (4 → raw 5 → 0.7·4+0.3·5 = 4.3 → round 4),
    // which is why the controller never ramped below. Applying every step
    // decisively is the minimal correction that keeps integer rounding truthful.
    if (queueSize <= threshold && !this.settled) {
      // Aggressive increase — essentially no queuing, raise by at least one.
      newLimit = this.concurrency + Math.max(1, beta);
    } else if (queueSize < alpha && !hasQueuing && !this.settled) {
      // Mild queuing (no significant EMA increase) — raise slowly by the
      // log-root step. Gated by `settled` too: once the sweet spot is found,
      // hysteresis stops ALL probing up until the next re-probe. Without this
      // gate, a settled controller at the optimum would still creep up one
      // step on every probe (queueSize 0 < alpha), keeping it a step above the
      // optimum and oscillating 4↔5↔6 instead of holding.
      newLimit = this.concurrency + step;
    } else if (queueSize > beta || hasQueuing) {
      // Heavy queuing OR significant EMA increase — pull back by the log-root step.
      newLimit = this.concurrency - step;
      this.settled = true;
    } else {
      // Sweet spot — hold. Mark settled so we stop probing up until the next
      // re-probe.
      newLimit = this.concurrency;
      this.settled = true;
    }

    this.setConcurrency(this.clamp(Math.round(newLimit)));

    this.completionsSinceLastProbe = 0;
  }

  private resetProbeJitter(): void {
    this.probeJitter = 0.5 + Math.random() * 0.5;
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
    // Math.max/Mathmin propagate NaN rather than clamping it, which would let
    // a non-numeric limit reach the scheduler and stall it. Infinities clamp
    // to the bounds normally.
    if (Number.isNaN(value)) return this.concurrency;
    return Math.max(this.minConcurrency, Math.min(this.maxConcurrency, value));
  }
}

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
