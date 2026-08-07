/**
 * Keeps changesets' prerelease mode in step with the branch being released.
 *
 * Stable branches publish normal versions; every other release branch
 * publishes under a prerelease tag. Running this before `changeset version`
 * or `changeset publish` means neither ever needs a human to remember
 * `pre enter` / `pre exit`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { log } from 'node:console';
import process from 'node:process';

const STABLE_BRANCHES = new Set(['main', 'master']);
const PRERELEASE_TAG = 'beta';
const PRE_STATE_FILE = '.changeset/pre.json';

const currentBranch =
  process.env.GITHUB_REF_NAME ??
  execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf-8',
  }).trim();

// `changeset pre exit` leaves the file behind with mode "exit" rather than
// deleting it, so the mode field is the state — not the file's existence.
const readPrereleaseMode = () => {
  if (!existsSync(PRE_STATE_FILE)) return 'none';
  return JSON.parse(readFileSync(PRE_STATE_FILE, 'utf-8')).mode;
};

const shouldBePrerelease = !STABLE_BRANCHES.has(currentBranch);
const isPrerelease = readPrereleaseMode() === 'pre';

if (shouldBePrerelease === isPrerelease) {
  log(
    `${currentBranch}: prerelease mode already ${isPrerelease ? `on (${PRERELEASE_TAG})` : 'off'}`
  );
} else {
  const args = shouldBePrerelease
    ? ['pre', 'enter', PRERELEASE_TAG]
    : ['pre', 'exit'];
  log(`${currentBranch}: running changeset ${args.join(' ')}`);
  execFileSync('changeset', args, { stdio: 'inherit' });
}
