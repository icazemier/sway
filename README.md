<img src="gibbons.png" width="200" />

# Sway

`Promise.all()` with adaptive concurrency control. Zero dependencies.

# Why

Concurrency is often an improvement in async code (e.g. `Promise.all()` ). But often one has too many concurrent tasks, ok... Too many, how many is too many?
So to solve this, one implements a way to "limit" concurrency. Then again, what would the maxConcurrency be, 4 or 8? 

Sway just puts 2 ideas together, (1st) an adaptive controller to control the (2nd) `maxConcurrency` and uses a feedback loop to adapt.

Sway automatically finds the optimal number of concurrent tasks -- you don't have to guess. Under the hood it watches task latency and adjusts concurrency up or down, using the same idea as [TCP Vegas](https://en.wikipedia.org/wiki/TCP_Vegas) and [Netflix's adaptive concurrency limiter](https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581).

## Runtime Compatibility

| Runtime | Support | Install |
|---------|---------|---------|
| Node.js 22+ | ✅ Native | `npm install @icazemier/sway` |
| Bun | ✅ Native | `bun add @icazemier/sway` |
| Deno | ✅ via `npm:` | See below |
| Browser | ✅ Native ESM | See below |

### Deno

```typescript
import { sway } from "npm:@icazemier/sway";
```

Run with the required permissions:

```bash
deno run --allow-env --allow-net --allow-read --allow-sys your-script.ts
```

### Browser

Use a bundler (Vite, Webpack, esbuild, etc.):

```typescript
import { sway } from '@icazemier/sway';
```

The published build is standard ESM with no dependencies, so it also works loaded directly as a module — serve `build/esm/index.js` from your own origin rather than a third-party CDN, which would put someone else's uptime and supply chain in front of your users.

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

For the common case of mapping items to async work, use `sway.map`:

```ts
const { results } = await sway.map(
  urls,
  async (url) => (await fetch(url)).json()
);
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

### `sway.allSettled` — never reject on task failure

Mirrors `Promise.allSettled`: run every task to completion and get a settle-result per input, even when some tasks throw.

```ts
const { results } = await sway.allSettled(
  urls.map(url => () => fetch(url))
);
for (const r of results) {
  if (r.status === 'fulfilled') console.log(r.value.status);
  else console.error(r.reason);
}
```

The returned promise never rejects on task failure -- only if the input iterator itself throws.

### `sway.map` — ergonomic mapping shortcut

Pass items and an async function directly, like `Array.prototype.map`. Saves the thunk-wrapping boilerplate.

```ts
const { results } = await sway.map(
  items,
  async (item, index) => process(item)
);
```

Items are pulled lazily from the source iterable, so generators with millions of items still work.

## Options

All values are **counts** or **ratios** -- no time-based units to worry about.

| Option               | Default | Description                                          |
| -------------------- | ------- | ---------------------------------------------------- |
| `maxConcurrency`     | `64`    | Upper bound for concurrent in-flight tasks           |
| `minConcurrency`     | `1`    | Lower bound for concurrent in-flight tasks            |
| `initialConcurrency` | `4`    | How many tasks to start with                          |
| `smoothingFactor`    | `0.3`  | Latency EMA responsiveness (0-1), lower = calmer      |
| `probeInterval`      | `8`    | Completed tasks between concurrency adjustments       |
| `probeMultiplier`    | `30`   | Completeness factor for the periodic baseline re-probe |

**Tip:** The defaults work well for most workloads. Start without options and only tune if you see a reason to.

## How it works

Most concurrency controllers use **throughput** (tasks/sec) to decide when to scale up or down. The problem: throughput is a *lagging* indicator -- it only drops *after* you've already overshot, and by then back-pressure has already piled up.

Sway uses **latency** instead. Latency is a *leading* indicator -- it rises *immediately* when concurrency exceeds the sweet spot, because tasks start queueing before throughput visibly drops. This is the same insight behind [TCP Vegas](https://en.wikipedia.org/wiki/TCP_Vegas) and [Netflix's adaptive concurrency limiter](https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581).

The controller tracks two values:

- **`minLatency`** -- the no-load baseline: the low percentile (P25) of a rolling window of recent task durations
- **`latencyEma`** -- an exponential moving average of recent task durations

Every `probeInterval` completions it estimates how many requests are queued behind
the resource, then adjusts:

```
queueSize = ceil(concurrency × (1 − minLatency / latencyEma))
```

`queueSize` is the number of in-flight requests that are waiting rather than being
served -- the tail-latency signal the controller steers on.

Decision bands are **proportional** to the current concurrency (Netflix's documented
intent for VegasLimit):

| Band | Bound | What happens |
| --- | --- | --- |
| No queuing | `queueSize ≤ 5%` | Aggressive increase |
| Mild queuing | `queueSize < 10%` | Slow increase (log-root step) |
| Heavy queuing | `queueSize > 10%` | Decrease (log-root step) |
| Sweet spot | in between | Hold |

The bands are rounded to integers, so the "mild queuing" (slow increase) band
only exists when `10% − 5%` of the limit spans at least one whole number — at
most small/medium limits (e.g. below 25, or 30-34) there is no integer `queueSize`
between the two bounds, so the controller jumps straight from aggressive increase
to decrease.

A latency ratio past the jitter dead-zone (1.15× the no-load floor) is treated as
queuing even when the size bands don't fire — so a single queued request at a tiny
limit still triggers a decrease.

The `minLatency` baseline is a **low percentile of a rolling window** of recent
latencies (P25 over the last 64 samples), refreshed by a periodic re-probe (every
~`probeMultiplier × concurrency` completions). It stays stable and exact on
deterministic resources, but recovers after an overshoot spike on jittery ones —
a strict monotonic minimum would cling to the absolute low tail of a jitter
distribution and read as false queuing forever. This is what stops concurrency from
climbing without bound on a resource that queues work: the no-load reference tracks
the floor, so persistent queueing always reads as a decrease signal.

## FAQ

### Do I need to pick a concurrency number?

No. The defaults (`initialConcurrency: 4`, `maxConcurrency: 64`) work for most workloads. Sway will find the right level automatically. You can set `maxConcurrency` as a safety cap if your downstream has a known hard limit.

### How many tasks does sway need to "warm up"?

The controller starts adjusting after the first `probeInterval` completions (default: 8 tasks). Within 2-3 probe windows it's usually near optimal. For very small batches (< 20 tasks), the overhead of learning may not pay off -- consider a fixed pool instead.

### Can sway make things slower than a fixed pool?

Sway's job is to find the right concurrency *without* knowing it in advance. On a
contention-limited resource it lands within ~1.1-1.2x of the optimal fixed pool -- the
one you'd pick if you already knew the perfect number. On a **queuing** resource the
value is different: total throughput is capped at capacity regardless of concurrency, so
sway's contribution is keeping concurrency (and thus queue depth / tail latency) near the
optimum instead of letting it climb until `maxConcurrency` stops it. If you *already
know* the right concurrency, a fixed pool is marginally faster.

### What happens on the first error?

Sway rejects immediately, just like `Promise.all()`. Remaining in-flight tasks are not cancelled (promises are not cancellable), but no new tasks are started.

### Does the order of results match the input?

Yes. `results[i]` corresponds to `tasks[i]`, regardless of completion order.

### Can I use sway with generators or async iterables?

Sway accepts any `Iterable` (arrays, generators, `Set`, custom iterables). Tasks are consumed lazily. Note: `AsyncIterable` is not currently supported -- the iterator must be synchronous, but each task function returns a promise.

### Why no `sway.any` or `sway.race`?

`Promise.any` and `Promise.race` are typically used with **small** alternative sets (2-5 mirrors, replicas, fallbacks). Sway's controller needs at least ~20 tasks to learn anything useful, and once one task settles the scheduler stops -- adaptive concurrency never gets to do its job. For race-to-first-success workloads you usually want full parallelism (fire everything at once); throttling literally delays the win. The native `Promise.any` / `Promise.race` are the right tools there.

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

### Settled-mode benchmarks (`sway.allSettled`)

500 tasks against the same contention resource (optimal = 8), with a fraction of tasks failing fast (~1ms pre-flight rejections). Ratios are vs. the best approach in each row:

| Failure rate | `Promise.allSettled` | Fixed c=8 | Fixed c=32 | **`sway.allSettled`** |
| --- | ---: | ---: | ---: | ---: |
| 10% (flaky) | 197x slower | **1.0x** | 8.2x slower | **1.16x slower** |
| 50% (very flaky) | 97x slower | **1.0x** | 7.8x slower | **1.09x slower** |
| 100% (fully cooked) | **1.0x** | 23x slower | 6.9x slower | 44x slower ✱ |

Same takeaway as plain `sway()`: adaptive control lands within ~1.1x of the optimal fixed pool **without being told what that optimum is**. Any fixed choice loses at one end of the spectrum -- `c=8` is great under contention and terrible without it; unbounded `Promise.allSettled` is the opposite. Sway adapts to whichever regime it finds itself in.

✱ At 100% failures the controller never receives a successful-task latency to learn from, so it stays at `initialConcurrency` (default 4). Cheap in absolute terms (~150ms for 500 fast-fail tasks) but not where adaptive shines. For a workload you *know* fails close to 100% of the time, use `Promise.allSettled` directly.

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

## Releasing

Releases run on [changesets](https://github.com/changesets/changesets). Any change that should reach users ships with a changeset describing it:

```bash
npm run changeset
```

Pick the bump type, write a one-line summary, and commit the generated file in `.changeset/` alongside your change. Merging into a release branch applies every pending changeset, commits the version bump and changelog, and publishes to npm and JSR.

Prerelease mode follows the branch automatically, so there is nothing to remember: releases from `main` are stable versions, and releases from any other branch land on the `beta` dist-tag. The release scripts run `scripts/pre-mode.mjs` first, which enters or leaves changesets' prerelease mode to match.

Publishing uses the runner's own npm with OIDC trusted publishing, so no npm token is stored in the repository. Both registries are then asserted to actually serve the released version, because publishing is idempotent and a green publish step on its own proves nothing.

## License

MIT
