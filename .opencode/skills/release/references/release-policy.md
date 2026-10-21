# Release policy

This is the deep reference behind the `release` skill. It records *why* the
release flow works the way it does, so a future contributor can reconstruct the
reasoning rather than just follow commands.

## Branching model

Sway follows a two-branch GitFlow-lite model:

- `development` — integration branch. All feature work merges here first.
- `main` — stable. The only way in is a promotion PR from `development`.

Releases are cut by *merging* a branch, never by a manual `npm publish`.

## Prerelease mode

Changesets tracks prerelease state in `.changeset/pre.json`:

```json
{ "mode": "pre", "tag": "beta" }
```

`scripts/pre-mode.mjs` keeps this in step with the branch being released:

- **Stable branches** (`main`, `master`): runs `changeset pre exit` and removes
  `pre.json` so the release lands on `latest`.
- **Anything else**: enters prerelease mode with tag `beta` if not already there.

### Why absence of the file matters

`changeset publish` chooses the dist tag by checking `preState !== undefined`,
never by reading `mode`. A leftover "exit" file would therefore push a stable
release to the `beta` tag and leave `latest` empty. Only deleting the file is
safe — which is exactly what `changeset version` does for stable releases.

## Version bumps land through PRs

GitHub requires a pull request on `main`/`development`, and a personal repo
cannot grant Actions a ruleset bypass. So the Release workflow:

1. Computes the bump locally (`npm run release:version`).
2. Commits it on a bot branch `chore/version-packages-<run-id>`.
3. Opens and merges that PR automatically.
4. Resets the local checkout onto the merged commit so the tag changesets
   creates during publish points at a commit actually on the release branch.

## The guard on main

`main` has no native rule for *which* branch a PR comes from, so the constraint
is enforced as a check in `guard-release-flow.yml`: the source branch must be
`development`, **unless** the author is `github-actions[bot]` (the version bump
and back-merge would otherwise deadlock the release). Make it a required status
check on `main` and releases can only ever be cut from `development`.

## Cross-version testing on release

The Release workflow runs a **single** Node version (the active LTS, 24.x), not
the full CI matrix. The rationale: CI already ran every supported version on the
PR that produced this commit; repeating it on the merge tests nothing new and
multiplies runners for every release.

## Registry verification

Publishing is idempotent, so a green `changeset publish` step proves nothing
shipped. After publishing, `verify:published` asserts both npm and JSR actually
serve the released version. `jsr publish` also exits 0 when it skips an
already-published version, which is why it is not treated as proof on its own.

## Back-merge

`changeset config` sets `baseBranch: main`, so the beta channel's next version
is computed against `main`. When `main` ships a stable version, nothing brings
that commit back to `development`, which still believes the old version is
current and would re-derive an already-shipped version. The Release workflow
therefore merges `main` into `development` via `chore/backmerge-main` after
every stable release.

### Why `--force` on the back-merge push

The back-merge branch is pushed with `--force` (not `--force-with-lease`): the
branch is never fetched locally, so a lease would have no remote-tracking ref to
compare against and would reject the push the moment the branch survived an
earlier release. Only that job writes it.
