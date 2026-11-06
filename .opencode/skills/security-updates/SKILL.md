---
name: Security Updates
description: Fix supply-chain vulnerabilities in sway's devDependencies and release the fix through the beta → stable pipeline
---

# Security Updates

This skill covers remediating supply-chain vulnerabilities in sway's
devDependencies (typically reported by `npm audit` / Dependabot) and shipping the
fix through the beta → stable release pipeline.

## Goal

Zero known vulnerabilities in `npm audit`, with the full verify chain green.

## Workflow

### 1. Identify the vulnerable devDependencies

```bash
npm audit
```

Sway ships zero runtime dependencies (`"dependencies": {}`), so nearly every
finding lands in `devDependencies`. Common culprits: `@changesets/cli`, `vitest`
+ `@vitest/coverage-v8`, `typedoc`, `eslint`/`typescript-eslint`.

### 2. Bump

Prefer targeted bumps to `^<current-major>` for the affected tool over
`npm audit fix --force` (which can jump majors you did not intend). Keep related
packages aligned — `vitest` and `@vitest/coverage-v8` must share a major version.

### 3. Verify the whole chain

```bash
npm audit          # expect: 0 vulnerabilities
npm run lint
npm run build      # tsc + typedoc docs
npm test
npm run smoke
npm run verify:pack
```

## Gotchas (current state)

- **Bench files are ordinary linted source now** — `src/*.bench.ts` use the
  test-wrapped bench API (`test('...', async ({ bench }) => ...)`) and are covered
  by eslint (they were removed from the ignore list). You may edit them if a
  dependency bump breaks them, but keep the API shape consistent.
- **typedoc copies `src/*.bench.ts` into `docs/media/`.** `vite.config.ts` pins
  `test.benchmark.include: ['src/**/*.bench.ts']` so `vitest bench` never picks up
  that copy (it fails on the unresolved `./sway.js` import). Don't remove the pin.
- **Test-only helpers don't ship.** `src/queuing-sim.ts` is used only by the
  specs and is excluded from `tsconfig-build-*.json` and `jsr.json` — verify with
  `npm pack --dry-run` after changing build excludes.
- Root `tsconfig.json` includes `./**/*.ts` and ESLint's
  `parserOptions.project` depends on that — don't add bench exclusions to it;
  typedoc uses `tsconfig-typedoc.json`.

## Release the fix

Follow the `release` skill. In short:

1. Add a `patch` changeset (`npm run changeset`).
2. Commit it with the dependency change on a feature branch; PR → `development` (beta).
3. After it lands, promote `development` → `main` for the stable release —
   remember the promotion gotcha: the `development → main` merge needs a pending
   changeset to actually ship `latest`.
4. Expect the back-merge PR; ensure it lands.
5. If the Release workflow fails, diagnose before republishing — see the
   `release` skill's "Diagnosing a broken release" (the action is pinned to
   v2.1.2; v1.x crashes in pre mode).

## Do-not-touch list

- Generated `build/` and `docs/` — produced by the build, not hand-edited.
- `package-lock.json` — npm-owned; change it via `npm install`.
- `.changeset/pre.json` — managed by `scripts/pre-mode.mjs`.

## References

- `tsconfig-typedoc.json` — typedoc-only config.
- `vite.config.ts` — `benchmark.include` guard.
- `scripts/pre-mode.mjs` — prerelease mode handling.
- `.github/workflows/ci.yml` / `release.yml` — verify and release pipelines.
- The `release` skill — the full release flow and failure diagnosis.
