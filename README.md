<img src="gibbons.png" width="200" />

# @icazemier/sway

`Promise.all()` with adaptive concurrency control. A gradient-based controller continuously measures throughput and adjusts the concurrency level to maximise task completion speed — zero dependencies.

## Is sway right for me?

Think of concurrency like lanes on a highway:
- **Too few lanes** (low concurrency) — cars crawl, road is underused
- **Too many cars** (high concurrency) — traffic jam, everything slows down
- **Sweet spot** — maximum flow

With a fixed pool you're guessing how many lanes to open. Guess wrong and you either waste capacity or cause a jam. **Sway figures out the right number of lanes while driving.**

> **The one-liner test:** "If I doubled the concurrency, could things get *slower*?"
>
> If yes — sway is for you. If no — just use `Promise.all()`.

### Use sway when:

- You're hitting an **API** and don't know its rate limits
- You're querying a **database** and don't know the connection pool sweet spot
- You're processing **files on disk** and don't know how many parallel reads the drive handles well
- Your tasks hit **different services** with varying capacity
- You're writing a **library or tool** where the end user's infrastructure is unknown

### Don't use sway when:

- You already **know** the exact right concurrency (just use a fixed pool)
- Your tasks are **pure computation** with no I/O (concurrency = CPU cores, done)
- You have **very few tasks** (< 20) — not enough for the controller to learn

## Install

```bash
npm install @icazemier/sway
```

## Usage

```ts
import { sway } from '@icazemier/sway';

const { results, stats } = await sway(
  urls.map(url => () => fetch(url).then(r => r.json())),
  { maxConcurrency: 16 }
);

console.log(results);              // resolved values in original order
console.log(stats.peakConcurrency); // highest concurrency reached
console.log(stats.avgConcurrency);  // average concurrency across the run
```

## How it works

Sway starts at `initialConcurrency` and probes every `probeInterval` completed tasks. Each probe measures throughput (tasks/sec) using an exponential moving average and compares it to the previous measurement:

- **Gradient > 0** — throughput improving, increase concurrency by 1
- **Gradient < 0** — throughput degrading, decrease concurrency by 1
- **Gradient = 0** — at optimum, hold steady

Concurrency is always clamped between `minConcurrency` and `maxConcurrency`. The `smoothingFactor` controls how responsive the EMA is to change (lower = calmer).

## Options

All values are **counts** or **ratios** — no time-based units.

| Option               | Default | Unit  | Description                                   |
| -------------------- | ------- | ----- | --------------------------------------------- |
| `maxConcurrency`     | `64`    | tasks | Max concurrent in-flight tasks                |
| `minConcurrency`     | `1`    | tasks  | Min concurrent in-flight tasks                |
| `initialConcurrency` | `4`    | tasks  | Concurrent in-flight tasks to start with      |
| `smoothingFactor`    | `0.3`  | ratio  | EMA smoothing (0–1), lower = calmer           |
| `probeInterval`      | `8`    | tasks  | Completed tasks between probe adjustments     |

## Error handling

Sway rejects on the first error, just like `Promise.all()`.

```ts
try {
  await sway(tasks);
} catch (err) {
  // first task rejection
}
```

## Iterables

Accepts any `Iterable` — arrays, generators, or custom iterables. Tasks are pulled lazily from the iterator.

```ts
function* generateTasks() {
  for (const id of ids) {
    yield () => processItem(id);
  }
}

const { results } = await sway(generateTasks());
```

## Benchmarks

Run `npm run benchmark` to compare sway against fixed-concurrency pools using [vitest bench](https://vitest.dev/guide/features.html#benchmarking) (tinybench).

## Advanced: AdaptiveController

The controller is exported separately for custom integrations.

```ts
import { AdaptiveController } from '@icazemier/sway';

const controller = new AdaptiveController({ maxConcurrency: 32 });
controller.getConcurrency();  // current level
controller.recordCompletion(); // signal a completed task
```

## License

MIT
