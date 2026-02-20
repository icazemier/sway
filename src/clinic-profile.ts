/**
 * Standalone profiling script for use with clinic doctor.
 *
 * Usage:
 *   npx clinic doctor -- npx tsx src/clinic-profile.ts
 *
 * This runs the same scenarios as sway.bench.ts but without vitest,
 * so clinic can instrument the single Node.js process directly.
 */
import { sway } from './sway.js';

const TASK_COUNT = 500;
const ITERATIONS = 5;

// ── Resource models (same as sway.bench.ts) ──────────────────────────

function createContentionResource(optimalConcurrency: number) {
  let inFlight = 0;

  return (baseMs: number): Promise<number> => {
    inFlight++;
    const load = inFlight / optimalConcurrency;
    const penalty = load > 1 ? baseMs * (load - 1) ** 2 * 4 : 0;
    const jitter = Math.random() * baseMs * 0.2;
    const actualDelay = baseMs + penalty + jitter;

    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight--;
        resolve(actualDelay);
      }, actualDelay);
    });
  };
}

function createQueuingResource(
  capacity: number,
  minServiceMs: number,
  maxServiceMs: number
) {
  let active = 0;
  const waiting: (() => void)[] = [];

  return (): Promise<void> => {
    return new Promise((resolve) => {
      const run = () => {
        active++;
        const serviceTime =
          minServiceMs + Math.random() * (maxServiceMs - minServiceMs);
        setTimeout(() => {
          active--;
          resolve();
          const next = waiting.shift();
          if (next) next();
        }, serviceTime);
      };

      if (active < capacity) {
        run();
      } else {
        waiting.push(run);
      }
    });
  };
}

function createShiftingResource(
  firstCapacity: number,
  secondCapacity: number,
  shiftAfter: number
) {
  let tasksSeen = 0;
  let inFlight = 0;

  return (baseMs: number): Promise<number> => {
    tasksSeen++;
    inFlight++;
    const capacity = tasksSeen <= shiftAfter ? firstCapacity : secondCapacity;
    const load = inFlight / capacity;
    const penalty = load > 1 ? baseMs * (load - 1) ** 2 * 4 : 0;
    const jitter = Math.random() * baseMs * 0.2;
    const actualDelay = baseMs + penalty + jitter;

    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight--;
        resolve(actualDelay);
      }, actualDelay);
    });
  };
}

// ── Runner ───────────────────────────────────────────────────────────

async function runScenario(
  name: string,
  iterations: number,
  fn: () => Promise<unknown>
) {
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  console.log(
    `  ${name.padEnd(50)} avg=${avg.toFixed(0)}ms  min=${min.toFixed(0)}ms  max=${max.toFixed(0)}ms`
  );
}

// ── Scenarios ────────────────────────────────────────────────────────

async function main() {
  console.log(`\nTask count: ${TASK_COUNT}, iterations: ${ITERATIONS}\n`);

  console.log('── Contention resource (optimal=8) ──');
  {
    const makeTasks = () => {
      const r = createContentionResource(8);
      return Array.from({ length: TASK_COUNT }, () => () => r(10));
    };
    await runScenario('sway (defaults, initial=4)', ITERATIONS, () =>
      sway(makeTasks())
    );
    await runScenario('sway (aggressive, initial=8)', ITERATIONS, () =>
      sway(makeTasks(), {
        initialConcurrency: 8,
        probeInterval: 4,
        smoothingFactor: 0.6,
      })
    );
  }

  console.log('\n── Contention resource (optimal=4) ──');
  {
    const makeTasks = () => {
      const r = createContentionResource(4);
      return Array.from({ length: TASK_COUNT }, () => () => r(15));
    };
    await runScenario('sway (defaults, initial=4)', ITERATIONS, () =>
      sway(makeTasks())
    );
    await runScenario('sway (calm, initial=2)', ITERATIONS, () =>
      sway(makeTasks(), {
        initialConcurrency: 2,
        probeInterval: 8,
        smoothingFactor: 0.2,
      })
    );
  }

  console.log('\n── Queuing resource (capacity=8, Netflix model) ──');
  {
    const makeTasks = () => {
      const r = createQueuingResource(8, 5, 15);
      return Array.from({ length: TASK_COUNT }, () => () => r());
    };
    await runScenario('sway (defaults, initial=4)', ITERATIONS, () =>
      sway(makeTasks())
    );
  }

  console.log('\n── Shifting capacity (8→4 at midpoint) ──');
  {
    const makeTasks = () => {
      const r = createShiftingResource(8, 4, TASK_COUNT / 2);
      return Array.from({ length: TASK_COUNT }, () => () => r(10));
    };
    await runScenario('sway (defaults, initial=4)', ITERATIONS, () =>
      sway(makeTasks())
    );
  }

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
