/**
 * Configuration options for {@link sway}.
 */
export interface SwayOptions {
  /** Upper bound for concurrent in-flight tasks (default: `64`) */
  maxConcurrency?: number;
  /** Lower bound for concurrent in-flight tasks (default: `1`) */
  minConcurrency?: number;
  /** Number of concurrent in-flight tasks to start with (default: `4`) */
  initialConcurrency?: number;
  /**
   * Latency EMA smoothing factor, ratio between 0 and 1 (default: `0.3`).
   * Governs how noisy the measured latency EMA is: lower values average the
   * latency more heavily (calmer queue-size estimates, fewer spurious
   * adjustments); higher values track the latest sample more eagerly.
   * Limit adjustments themselves are decisive integer steps — see
   * `recordCompletion` for why smoothing them through an integer limit would
   * erase them after rounding.
   */
  smoothingFactor?: number;
  /** Number of completed tasks between probe adjustments (default: `8`) */
  probeInterval?: number;
  /**
   * Completeness factor for the periodic re-probe: the baseline is refreshed
   * after roughly `jitter × probeMultiplier × concurrency` completions.
   * Higher values probe less often (default: `30`)
   */
  probeMultiplier?: number;
}

/**
 * Performance telemetry collected during a {@link sway} run.
 */
export interface SwayStats {
  /** Total number of tasks that were executed */
  totalTasks: number;
  /** Wall-clock duration of the entire run in milliseconds */
  totalDurationMs: number;
  /** Highest concurrency level reached */
  peakConcurrency: number;
  /** Weighted average concurrency level across the run */
  avgConcurrency: number;
  /** Number of times the controller changed the concurrency level */
  adjustments: number;
}

/**
 * Return value of {@link sway}.
 *
 * @typeParam T - The resolved type of each task
 */
export interface SwayResult<T> {
  /** Resolved values in the same order as the input tasks */
  results: T[];
  /** Performance telemetry for the run */
  stats: SwayStats;
}
