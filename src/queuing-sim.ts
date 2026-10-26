/**
 * Deterministic queuing-resource simulator for the AdaptiveController spec.
 *
 * This mirrors `createQueuingResource` in `bench-resources.ts` exactly, but
 * with a **fixed** service time (no `Math.random()`) so that capacity-1 and
 * capacity-4 overshoot can be reproduced bit-for-bit across runs.
 *
 * The wall-clock benchmark on a queuing resource is flat/noise-dominated:
 * throughput is capped at `capacity / serviceTime` regardless of concurrency,
 * so ms alone cannot reveal overshoot. What the controller actually controls —
 * and what a truthful test must measure — is the **observed latency per task**
 * (queue depth = tail latency) and the **concurrency it settles on**. This
 * simulator exposes both deterministically.
 */

export interface QueuingTrace {
  /** Per-completion `{ concurrency, latency }` as seen by the controller. */
  trace: Array<{ concurrency: number; latency: number }>;
  peakConcurrency: number;
  avgConcurrency: number;
}

/**
 * Run a deterministic scheduling loop identical in shape to `sway.ts` against
 * a semaphore resource with `capacity` slots and a fixed `serviceTime`.
 *
 * - Tasks are dispatched up to the controller's current concurrency limit.
 * - If a slot is free, service starts immediately (latency = serviceTime).
 * - Otherwise the task waits FIFO; when a slot frees it starts service, so its
 *   latency is `waitTime + serviceTime`.
 *
 * `elapsed` is a deterministic clock advanced only by service completions,
 * mirroring the wall-clock behaviour of `createQueuingResource` without jitter.
 */
export function runQueuingSim(
  controller: {
    getConcurrency(): number;
    recordCompletion(d: number, inflight?: number, didDrop?: boolean): void;
  },
  capacity: number,
  serviceTime: number,
  taskCount: number
): QueuingTrace {
  // Tasks waiting for a slot, with the wall-clock time they were dispatched.
  const waiting: Array<{ start: number }> = [];
  // Tasks currently in service, with their absolute completion time.
  const inservice: Array<{ start: number; done: number }> = [];

  let elapsed = 0;
  let dispatched = 0;
  const trace: Array<{ concurrency: number; latency: number }> = [];

  // Complete the task with the earliest completion time: advance the clock,
  // record its latency, and pull the next waiting task into service. Parallel
  // slots genuinely overlap — capacity tasks started at the same time all
  // finish serviceTime later — so `elapsed` is the max completion time, not a
  // sum of per-task durations.
  const completeNext = (): void => {
    let idx = 0;
    for (let i = 1; i < inservice.length; i++) {
      if (inservice[i].done < inservice[idx].done) idx = i;
    }
    const t = inservice.splice(idx, 1)[0];
    elapsed = Math.max(elapsed, t.done);
    const latency = elapsed - t.start;
    const concurrency = controller.getConcurrency();
    trace.push({ concurrency, latency });
    // Pass the number of tasks still in flight excluding this one, matching
    // how `sway.ts` reports `activeTasks` after decrementing it.
    controller.recordCompletion(latency, dispatched - trace.length);

    // Release waiting tasks into freed slots (FIFO). A waiting task keeps its
    // original dispatch time so its observed latency includes the time it spent
    // queued: `done = elapsed + serviceTime`, latency = done - original start.
    while (waiting.length > 0 && inservice.length < capacity) {
      const w = waiting.shift();
      if (w === undefined) break; // guarded by waiting.length > 0 above
      inservice.push({ start: w.start, done: elapsed + serviceTime });
    }
  };

  // Dispatch one task at the current time, starting its service if a slot is
  // free and queueing it otherwise.
  const dispatchOne = (): void => {
    if (inservice.length < capacity) {
      inservice.push({ start: elapsed, done: elapsed + serviceTime });
    } else {
      waiting.push({ start: elapsed });
    }
  };

  // Main loop: keep dispatching up to the concurrency limit, advancing service
  // whenever the pool cannot grow.
  while (dispatched < taskCount) {
    const limit = controller.getConcurrency();
    const inFlight = dispatched - trace.length;
    if (inFlight < limit) {
      dispatchOne();
      dispatched++;
      continue;
    }
    // Pool is at the limit — advance service so a slot frees.
    if (inservice.length > 0) {
      completeNext();
    } else {
      // No task in service but we hit the dispatch limit: this can only happen
      // when the queue is deep and the limit is large enough to dispatch more
      // than capacity. Advance the oldest waiting task into service.
      const w = waiting.shift();
      if (w === undefined) break; // guarded by the empty-waiting fallback below
      inservice.push({ start: w.start, done: elapsed + serviceTime });
    }
  }

  // Drain: complete every in-service and waiting task.
  while (inservice.length > 0 || waiting.length > 0) {
    if (inservice.length > 0) {
      completeNext();
    } else {
      const w = waiting.shift();
      if (w === undefined) break; // guarded by waiting.length > 0 above
      inservice.push({ start: w.start, done: elapsed + serviceTime });
    }
  }

  let peak = 0;
  let sum = 0;
  for (const t of trace) {
    if (t.concurrency > peak) peak = t.concurrency;
    sum += t.concurrency;
  }
  return {
    trace,
    peakConcurrency: peak,
    avgConcurrency: sum / (trace.length || 1),
  };
}
