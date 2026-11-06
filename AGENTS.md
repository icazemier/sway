# Project instructions

Sway is a zero-dependency TypeScript library: `Promise.all()` with adaptive,
latency-based (VegasLimit-style) concurrency control. Runtime compatibility is
Node 22+, Bun, and Deno. This file is the always-loaded orientation; deep
workflows live in skills (load one with the `skill` tool or `@skill-id`).

## Commands

```bash
npm test              # vitest run --coverage (unit tests, NOT benchmarks)
npm run lint          # eslint over .ts
npm run build         # tsc esm+cjs → fixup → typedoc docs
npm run smoke         # smoke-test built artifacts as a consumer
npm run verify:pack   # install the packed tarball in a clean dir
npm run verify:published  # assert both registries serve the current version
npm run benchmark     # vitest bench (dev tool, not part of CI)
npm run changeset     # author a changeset for a release
```

The verify chain for any change: `lint` → `build` → `test` → `smoke`.
CI also covers `pack`, plus Bun (`bun install/run build/test`) and Deno
(`compat/deno.ts`).

## Source layout

- `src/index.ts` — public entry point.
- `src/*.ts` — implementation (`sway.ts`, `sway-map.ts`, `sway-all-settled.ts`,
  `adaptive-controller.ts`, `interfaces.ts`).
- `src/*.spec.ts` — unit tests, run by `npm test`.
- `src/*.bench.ts` + `src/bench-resources.ts` — benchmarks (test-wrapped vitest
  bench API, linted; run via `npm run benchmark`, not part of CI).
- `src/queuing-sim.ts` — test-only deterministic simulator; excluded from the
  build tsconfigs and `jsr.json`, never ships.
- `scripts/*.mjs` — ESM Node scripts (release plumbing).
- `compat/deno.ts` — Deno import smoke test.

## Do not touch

- Root `tsconfig.json` — keep it clean of bench exclusions; ESLint's
  `parserOptions.project: 'tsconfig.json'` depends on it.
- Generated `build/` and `docs/` — produced by the build, not hand-edited.
- `package-lock.json` — npm-owned, change it via `npm install`.
- `.changeset/pre.json` — managed by `scripts/pre-mode.mjs`.

## TypeScript / typedoc

- `tsconfig.json` — base config; includes `./**/*.ts`; used by ESLint.
- `tsconfig-typedoc.json` — typedoc-only, extends base but **excludes**
  `./**/*.bench.ts` and `./bench-resources.ts`. The `docs` script points here.
- typedoc copies `src/*.bench.ts` into `docs/media/`; `vite.config.ts` pins
  `test.benchmark.include: ['src/**/*.bench.ts']` so `vitest bench` never picks
  up that copy. Don't remove either guard.

## Release model

GitFlow-style, changesets-driven. Releases happen by *merging*, never manual
`npm publish`.

- `development` → beta (`pre` mode, tag `beta`).
- `main` → stable (`latest`); the only human way in is a promotion PR from
  `development` (enforced by `guard-release-flow.yml`). A `development → main`
  merge needs a pending changeset to actually ship `latest`.
- `scripts/pre-mode.mjs` auto-enters/exits prerelease mode; run it via
  `npm run release:version` / `npm run release`.
- `changesets/action` in `release.yml` is pinned to **v2.1.2** — v1.x crashes in
  pre mode (`ENOENT .changeset/pre/changes.md`). Don't downgrade it.
- After every `main` release a `chore: back-merge main into development` PR must
  land, or the beta channel computes stale versions.

Add a changeset (`npm run changeset`) for any user-facing change. Dev-tooling
and CI-only changes (workflows, `AGENTS.md`, skills) do **not** need a changeset.

Deep release flow: see the `release` skill.

## Skills

- `@release` — cut a release through the changesets GitFlow pipeline.
- `@security-updates` — fix supply-chain vulnerabilities and release the fix
  (includes the typedoc/benchmark gotcha).
- `@benchmarking` — work with the vitest-bench files and README tables.
- `@adaptive-controller` — tinker safely on the latency-based (VegasLimit-style)
  controller and the scheduler.
