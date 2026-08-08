/**
 * Verifies the built package works through both entry points.
 *
 * The unit tests import TypeScript sources, so they cannot catch a build that
 * emits the wrong module format — a CJS build containing ESM syntax passes
 * every test and still throws for anyone calling `require()`. This runs the
 * real artifacts the way consumers load them.
 */
import { createRequire } from 'node:module';
import { log, error } from 'node:console';
import process from 'node:process';

const require = createRequire(import.meta.url);

const check = async (label, entry) => {
  const { sway, AdaptiveController } = entry;

  if (typeof sway !== 'function') throw new Error('sway is not a function');
  if (typeof sway.allSettled !== 'function')
    throw new Error('sway.allSettled is missing');
  if (typeof sway.map !== 'function') throw new Error('sway.map is missing');
  if (typeof AdaptiveController !== 'function')
    throw new Error('AdaptiveController is not a constructor');

  const { results } = await sway([async () => 1, async () => 2, async () => 3]);
  if (results.join(',') !== '1,2,3')
    throw new Error(`unexpected results: ${results.join(',')}`);

  const settled = await sway.allSettled([
    async () => {
      throw new Error('boom');
    },
  ]);
  if (settled.results[0].status !== 'rejected')
    throw new Error('allSettled did not report a rejection');

  log(`  ${label}: ok`);
};

try {
  await check('require (cjs)', require('../build/cjs/index.js'));
  await check('import  (esm)', await import('../build/esm/index.js'));
  log('both entry points work');
} catch (failure) {
  error(`smoke test failed: ${failure.message}`);
  process.exit(1);
}
