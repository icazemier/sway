---
name: Release
description: Cut a release of sway through the changesets GitFlow pipeline — beta from development, stable from main
---

# Release

Sway releases run on [changesets](https://github.com/changesets/changesets) with a
GitFlow branch model. This skill covers the full flow: authoring a changeset,
understanding prerelease mode, and what actually happens on merge.

## The branch model (GitFlow)

| Branch       | Publishes            | Dist tag | Prerelease mode |
| ------------ | -------------------- | -------- | --------------- |
| `main`       | Stable `2.x.y`       | `latest` | Exits `pre`     |
| `development`| Beta `2.x.y-beta.n`  | `beta`   | Enters `pre`    |

The mode is managed automatically by `scripts/pre-mode.mjs` — nothing to remember.
Run `npm run pre-mode` if you need to see/force the state.

## Authoring a changeset

Any change that should reach users ships with a changeset:

```bash
npm run changeset
```

Pick the bump type, write a one-line summary, and commit the generated file in
`.changeset/` **alongside your change** on the feature branch.

- Bump type should reflect the change: breaking → `major`, feature → `minor`,
  fix/chore → `patch`.
- Dev-tooling and CI-only changes (`AGENTS.md`, workflows, skill docs) do NOT
  need a changeset — they never reach package consumers.

## Release commands

| Script                | Purpose                                                    |
| --------------------- | ---------------------------------------------------------- |
| `npm run changeset`   | Interactive changeset authoring                            |
| `npm run release:version` | `pre-mode` + `changeset version` + lockfile sync        |
| `npm run release`     | `pre-mode` + `changeset publish` (npm + JSR)               |
| `npm run publish:jsr` | Publish to JSR only                                        |
| `npm run pre-mode`    | Enter/exit prerelease mode to match the current branch     |

## What happens on merge (release.yml)

Merging into `main` **or** `development` triggers the Release workflow:

1. Test (Node 24), lint, build, smoke.
2. Verify the package installs as a consumer (`pack`).
3. Apply pending changesets: `npm run release:version`.
4. Land the bump via a bot PR (`chore/version-packages-<run-id>`), merged
   automatically. This is why a personal repo can require a PR on a branch that
   Actions also pushes to.
5. Publish via `changesets/action` (`npm run release`) with OIDC trusted
   publishing; creates the git tag + GitHub release.
6. Publish to JSR (version synced from `package.json`).
7. Verify both registries actually serve the version.

## The guard on main

`.github/workflows/guard-release-flow.yml` makes `main` accept **only**
`development` as a source branch (for human PRs). Bot branches — the version
bump and the back-merge — are exempt because they come from `github-actions[bot]`.

**Practical rule:** never open a human PR into `main` directly. Merge into
`development` first, then promote `development` → `main` to cut the release.

## The back-merge

A stable release from `main` tags a commit that `development` does not contain.
Without a back-merge, `development` computes its next beta from a stale version
and re-derives an already-shipped number. The Release workflow therefore opens
`chore/backmerge-main` (→ `development`) after every `main` release and merges it.

**If a back-merge PR is left open or fails**, every subsequent release cut on
`main` stays invisible to the beta channel. Resolve it by hand.

## Common mistakes

- Releasing to `latest` when only a beta was intended — always confirm the
  current branch is `main` before expecting a stable release.
- Forgetting that `changeset publish` picks the dist tag from `preState`, so a
  leftover `pre.json` would push a stable release to the prerelease tag.
  `pre-mode.mjs` handles this — run it, don't work around it.
- Adding a changeset for dev-tooling changes that don't reach consumers.

## References

- `references/release-policy.md` — full release-flow policy and rationale.
- `scripts/pre-mode.mjs` — prerelease mode logic.
- `.changeset/config.json` — changesets configuration.
- `.github/workflows/release.yml` — the release pipeline.
- `.github/workflows/guard-release-flow.yml` — the main-branch guard.
