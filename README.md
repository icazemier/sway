<img src="gibbons.png" width="200" />

# Sway

`Promise.all()` with adaptive concurrency control. Zero dependencies.

# Why

Concurrency is often an improvement in async code (e.g. `Promise.all()` ). But often one has too many concurrent tasks, ok... Too many, how many is too many?
So to solve this, one implements a way to "limit" concurrency. Then again, what would the maxConcurrency be, 4 or 8? 

Sway just puts 2 ideas together, (1st) an adaptive controller to control the (2nd) `maxConcurrency` and uses a feedback loop to adapt.

Sway automatically finds the optimal number of concurrent tasks -- you don't have to guess. Under the hood it uses a latency-gradient algorithm inspired by [TCP Vegas](https://en.wikipedia.org/wiki/TCP_Vegas) and [Netflix's adaptive concurrency limiter](https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581).

## Quick start

```bash
npm install @icazemier/sway
```

```ts
import { sway } from '@icazemier/sway';

const { results, stats } = await sway(
  urls.map(url => () => fetch(url).then(r => r.json()))
);

console.log(results);               // resolved values in original order
console.log(stats.peakConcurrency);  // highest concurrency reached
console.log(stats.avgConcurrency);   // average concurrency across the run
```

That's it. No concurrency number to pick -- sway figures it out.

## Is sway right for me?

Think of concurrency like lanes on a highway:

- **Too few lanes** (low concurrency) -- cars crawl, road is underused
- **Too many cars** (high concurrency) -- traffic jam, everything slows down
- **Sweet spot** -- maximum flow

With a fixed pool you're guessing how many lanes to open. Guess wrong and you either waste capacity or cause a jam. **Sway figures out the right number of lanes while driving.**

> **The one-liner test:** "If I doubled the concurrency, could things get *slower*?"
>
> If yes -- sway is for you. If no -- just use `Promise.all()`.

### Use sway when

- You're hitting an **API** and don't know its rate limits
- You're querying a **database** and don't know the connection pool sweet spot
- You're processing **files on disk** and don't know how many parallel reads the drive handles well
- Your tasks hit **different services** with varying capacity
- You're writing a **library or tool** where the end user's infrastructure is unknown

### Don't use sway when

- You already **know** the exact right concurrency (just use a fixed pool)
- Your tasks are **pure computation** with no I/O (concurrency = CPU cores, done)
- You have **very few tasks** (< 20) -- not enough for the controller to learn

## Usage

### Basic

Pass an array of task functions (thunks). Each thunk is a zero-argument function that returns a promise:

```ts
const tasks = urls.map(url => () => fetch(url));
const { results } = await sway(tasks);
```

### With options

```ts
const { results, stats } = await sway(tasks, {
  maxConcurrency: 16,    // never run more than 16 at once
  initialConcurrency: 2, // start cautiously
});
```

### Error handling

Sway rejects on the first error, just like `Promise.all()`:

```ts
try {
  await sway(tasks);
} catch (err) {
  // first task rejection
}
```

### Generators and iterables

Accepts any `Iterable` -- arrays, generators, or custom iterables. Tasks are pulled lazily from the iterator, so you can feed millions of tasks without building the full array in memory:

```ts
function* generateTasks() {
  for (const id of ids) {
    yield () => processItem(id);
  }
}

const { results } = await sway(generateTasks());
```

### Stats

Every run returns a `stats` object with performance telemetry:

```ts
const { stats } = await sway(tasks);

stats.totalTasks;      // number of tasks executed
stats.totalDurationMs; // wall-clock time in ms
stats.peakConcurrency; // highest concurrency reached
stats.avgConcurrency;  // weighted average concurrency
stats.adjustments;     // how many times the controller changed level
```

## Options

All values are **counts** or **ratios** -- no time-based units to worry about.

| Option               | Default | Description                                          |
| -------------------- | ------- | ---------------------------------------------------- |
| `maxConcurrency`     | `64`    | Upper bound for concurrent in-flight tasks           |
| `minConcurrency`     | `1`    | Lower bound for concurrent in-flight tasks            |
| `initialConcurrency` | `4`    | How many tasks to start with                          |
| `smoothingFactor`    | `0.3`  | Latency EMA responsiveness (0-1), lower = calmer      |
| `probeInterval`      | `8`    | Completed tasks between concurrency adjustments       |

**Tip:** The defaults work well for most workloads. Start without options and only tune if you see a reason to.

## How it works

Most concurrency controllers use **throughput** (tasks/sec) to decide when to scale up or down. The problem: throughput is a *lagging* indicator -- it only drops *after* you've already overshot, and by then back-pressure has already piled up.

Sway uses **latency** instead. Latency is a *leading* indicator -- it rises *immediately* when concurrency exceeds the sweet spot, because tasks start queueing before throughput visibly drops. This is the same insight behind [TCP Vegas](https://en.wikipedia.org/wiki/TCP_Vegas) and [Netflix's adaptive concurrency limiter](https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581).

The controller tracks two values:

- **`minLatency`** -- the lowest task duration observed (learned no-contention baseline)
- **`latencyEma`** -- an exponential moving average of recent task durations

Every `probeInterval` completions it computes:

```
gradient    = minLatency / latencyEma          // 0..1, where 1 = no contention
newLimit    = concurrency × gradient + √concurrency
concurrency = clamp(round(newLimit), min, max)
```

| Situation | gradient | What happens |
| --- | --- | --- |
| No contention (latency ≈ baseline) | ≈ 1 | Concurrency grows by √n |
| Moderate contention (latency 2× baseline) | ≈ 0.5 | Concurrency roughly halves, plus small √n bump |
| Heavy contention (latency 10× baseline) | ≈ 0.1 | Concurrency drops sharply |

The `minLatency` baseline slowly decays toward the EMA so that a single anomalously-fast early task doesn't permanently skew the gradient. Genuinely fast tasks will continuously refresh the baseline.

## FAQ

### Do I need to pick a concurrency number?

No. The defaults (`initialConcurrency: 4`, `maxConcurrency: 64`) work for most workloads. Sway will find the right level automatically. You can set `maxConcurrency` as a safety cap if your downstream has a known hard limit.

### How many tasks does sway need to "warm up"?

The controller starts adjusting after the first `probeInterval` completions (default: 8 tasks). Within 2-3 probe windows it's usually near optimal. For very small batches (< 20 tasks), the overhead of learning may not pay off -- consider a fixed pool instead.

### Can sway make things slower than a fixed pool?

In benchmarks, sway runs within ~1.1-1.2x of the optimal fixed pool -- the one you'd pick if you already knew the perfect number. The small overhead comes from the learning phase. If you *already know* the right concurrency, a fixed pool will be marginally faster.

### What happens on the first error?

Sway rejects immediately, just like `Promise.all()`. Remaining in-flight tasks are not cancelled (promises are not cancellable), but no new tasks are started.

### Does the order of results match the input?

Yes. `results[i]` corresponds to `tasks[i]`, regardless of completion order.

### Can I use sway with generators or async iterables?

Sway accepts any `Iterable` (arrays, generators, `Set`, custom iterables). Tasks are consumed lazily. Note: `AsyncIterable` is not currently supported -- the iterator must be synchronous, but each task function returns a promise.

## Benchmarks

500 tasks, simulated back-pressure resource ([source](src/sway.bench.ts)).

**Contention resource (optimal = 8)**

| Approach | Time | vs Optimal |
| --- | ---: | ---: |
| fixed pool (c=8) -- optimal | 687ms | 1.0x |
| **sway (defaults)** | **802ms** | **1.2x** |
| fixed pool (c=32) -- too high | 5,672ms | 8.3x |
| fixed pool (c=64) -- way too high | 15,022ms | 21.9x |

**Shifting capacity (8 to 4 mid-run)**

| Approach | Time | vs Best |
| --- | ---: | ---: |
| fixed pool (c=6) -- best compromise | 1,413ms | 1.0x |
| **sway (defaults)** | **1,693ms** | **1.2x** |
| fixed pool (c=8) -- wrong after shift | 2,025ms | 1.4x |

Sway's ~1.2x overhead is the cost of learning. A wrong fixed guess costs 8-50x.

Reproduce with `npm run benchmark` ([vitest bench](https://vitest.dev/guide/features.html#benchmarking)). Resource models inspired by [Netflix's concurrency-limits](https://github.com/Netflix/concurrency-limits) ([blog post](https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581)).

## Advanced: AdaptiveController

The controller is exported separately if you want to build your own scheduling loop:

```ts
import { AdaptiveController } from '@icazemier/sway';

const controller = new AdaptiveController({ maxConcurrency: 32 });

controller.getConcurrency();       // current concurrency level
controller.recordCompletion(12.5); // signal a task completed in 12.5ms
controller.getStats(100, 5000);    // get telemetry snapshot
```

## License

MIT
