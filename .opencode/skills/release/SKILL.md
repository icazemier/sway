---
name: Release
description: Cut a release of sway through the changesets GitFlow pipeline — beta from development, stable from main
---

# Release

Sway releases run on [changesets](https://github.com/changesets/changesets) with a
GitFlow branch model. This skill covers the full flow: authoring a changeset,
prerelease mode, what happens on merge, and how to diagnose a broken release.

## The branch model (GitFlow)

| Branch        | Publishes           | Dist tag | Prerelease mode |
| ------------- | ------------------- | -------- | --------------- |
| `main`        | Stable `2.x.y`      | `latest` | Exits `pre`     |
| `development` | Beta `2.x.y-beta.n` | `beta`   | Enters `pre`    |

The mode is managed automatically by `scripts/pre-mode.mjs` — never hand-edit
`.changeset/pre.json`; run `npm run pre-mode` if you need to inspect/force state.

## Authoring a changeset

Any change that should reach users ships with a changeset:

```bash
npm run changeset
```

Commit the generated file in `.changeset/` **alongside your change** on the
feature branch. Bump type: breaking → `major`, feature → `minor`, fix/chore →
`patch`. Dev-tooling and CI-only changes (workflows, `AGENTS.md`, skills) do NOT
need a changeset.

## Release commands

| Script                  | Purpose                                             |
| ----------------------- | --------------------------------------------------- |
| `npm run changeset`     | Interactive changeset authoring                     |
| `npm run release:version` | `pre-mode` + `changeset version` + lockfile sync  |
| `npm run release`       | `pre-mode` + `changeset publish` (npm via OIDC)     |
| `npm run publish:jsr`   | Publish to JSR only                                 |
| `npm run pre-mode`      | Enter/exit prerelease mode to match the branch      |
| `npm run verify:published` | Assert both registries serve the current version |

## What happens on merge (release.yml)

Merging into `main` **or** `development` triggers the Release workflow:

1. Test (Node 24), lint, build, smoke; `pack` verifies the tarball installs as a consumer.
2. Apply pending changesets: `npm run release:version`.
3. Land the bump via a bot PR (`chore/version-packages-<run-id>`), auto-merged —
   this is why a personal repo can require a PR on a branch Actions also pushes to.
4. Publish via `changesets/action` (`publish-script: npm run release`) with OIDC
   trusted publishing; creates the git tag + GitHub release
   (`push-with-git-cli: true`).
5. Publish to JSR (version synced from `package.json`).
6. Verify both registries actually serve the version (`npm run verify:published`).

## Hard rule: the changesets/action version

`.github/workflows/release.yml` pins `changesets/action` to **v2.1.2**
(commit `ae32849d5ba541f9ae29e40e22a623bc13562f51`). Do not downgrade to v1.x:
**v1.9.0 crashes in pre mode** with
`ENOENT: .changeset/pre/changes.md` — its legacy changesets-v1 scan reads that
file whenever a `.changeset/pre/` directory exists, but CLI v3 keeps individual
changesets there and state in `pre.json`, never `changes.md`. Every v1.9.0 release
in pre mode failed before `npm run release` even ran. v2 renamed the inputs
(`publish` → `publish-script`, `createGithubReleases` → `create-github-releases`,
`commitMode: git-cli` → `push-with-git-cli: true`); keep them in sync if you bump.

## Diagnosing a broken release

Symptom of the v1.9.0 crash (and similar): the version is bumped **in git** but
never published. Check both sides:

```bash
git show origin/development:package.json | grep '"version"'   # bumped?
npm view @icazemier/sway dist-tags                               # actually published?
gh run list --workflow Release --limit 5                         # which runs failed?
gh run view <id> --log-failed                                    # read the error
```

`beta` dist-tag should track the latest `-beta.N` on `development`; `latest`
only moves from `main`. If they lag `package.json`, the Publish step failed —
read the Release run log before republishing (publishing is idempotent; both
registries skip an existing version).

## The guard on main

`.github/workflows/guard-release-flow.yml` makes `main` accept **only**
`development` as a source branch (for human PRs). Bot branches (version bump,
back-merge) are exempt. Practical rule: never open a human PR into `main`
directly — merge into `development` first, then promote `development` → `main`.

## Promotion gotcha: `development → main` needs a changeset to ship

A plain `development → main` merge with **no pending changesets publishes
nothing**: the release workflow exits pre mode, `changeset version` finds nothing
to consume, and `changeset publish` skips versions already on npm (the betas), so
`latest` stays stale. To promote released beta fixes to `latest`, add a **patch
changeset** on `development`, merge it (produces the next `-beta.N`), then merge
`development → main`.

## The back-merge

A stable release from `main` tags a commit `development` does not contain. The
Release workflow opens `chore/backmerge-main` (→ `development`) after every `main`
release and merges it. If it is left open or fails, every later `main` release
stays invisible to the beta channel — resolve it by hand.

## Common mistakes

- Expecting `latest` from a `development` merge — that only ever produces `beta`.
- A leftover `pre.json` pushes a stable release to the prerelease tag —
  `pre-mode.mjs` handles this; run it, don't work around it.
- Adding changesets for dev-tooling/CI-only changes.
- Re-publishing after a red `verify:published` without checking whether the
  version is actually served now (registry propagation lag) — publishing is
  idempotent, so republishing is never the fix for a propagation flake.

## References

- `references/release-policy.md` — full release-flow policy and rationale.
- `scripts/pre-mode.mjs` — prerelease mode logic.
- `.changeset/config.json`, `.changeset/pre.json` — changesets config/state.
- `.github/workflows/release.yml` — the release pipeline (action pin lives here).
- `.github/workflows/guard-release-flow.yml` — the main-branch guard.
