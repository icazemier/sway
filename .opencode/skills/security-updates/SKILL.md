---
name: Security Updates
description: Fix supply-chain vulnerabilities in sway's devDependencies and release the fix — with the typedoc/benchmark gotcha handled
---

# Security Updates

This skill covers remediating supply-chain vulnerabilities in sway's
devDependencies (typically reported by `npm audit` / Dependabot) and shipping
the fix through the beta → stable release pipeline.

## Goal

Zero known vulnerabilities in `npm audit`, with the full verify chain green and
the **benchmark files untouched**.

## Workflow

### 1. Identify the vulnerable devDependencies

```bash
npm audit
```

Sway ships zero runtime dependencies (`"dependencies": {}`), so nearly every
finding lands in `devDependencies`. Common culprits: `@changesets/cli`, `vitest`
+ `@vitest/coverage-v8`, `typedoc`, `eslint`/`typescript-eslint`.

### 2. Bump

Prefer targeted bumps to `^<current-major>` for the affected tool, over
`npm audit fix --force` (which can jump majors you did not intend). For example:

```bash
npm install -D @changesets/cli@^3.0.3 vitest@^5.0.5 @vitest/coverage-v8@^5.0.5
```

Keep the dependency set aligned — `vitest` and `@vitest/coverage-v8` must share
a major version.

### 3. Verify the whole chain

```bash
npm audit          # expect: 0 vulnerabilities
npm run lint
npm run build      # includes typedoc docs
npm test
npm run smoke
```

The **benchmark files are the trap**: `npm run benchmark` is *not* part of the
verify chain and the bench files must stay untouched.

## The typedoc / benchmark gotcha (critical)

A devDependency bump can break the docs build even when tests pass. Root cause:
`typedoc` compiles the TS program from `tsconfig.json`, which includes
`./**/*.ts` — so it pulls in `src/*.bench.ts`, which uses APIs (e.g. vitest v4's
top-level `bench`) that a newer vitest removed.

Rules:

- **Never edit `src/*.bench.ts`** — they use the vitest v4 `bench` API and are
  sacred.
- **Never exclude bench files from the root `tsconfig.json`** — ESLint's
  `parserOptions.project: 'tsconfig.json'` will error if the bench files are not
  in the program.
- **Fix it via `tsconfig-typedoc.json`** — the typedoc build already points at
  this dedicated config (`docs` script: `typedoc --out docs --tsconfig
  tsconfig-typedoc.json src/index.ts`), which excludes `./**/*.bench.ts` and
  `./bench-resources.ts`. If the bump changes the TS API, adjust *that* file.

## Release the fix

Follow the `release` skill. In short:

1. Add a `patch` changeset (`npm run changeset`).
2. Commit it with the dependency change on a feature branch.
3. PR → `development` (beta). After it lands, promote `development` → `main` for
   the stable release.
4. Expect the back-merge PR; ensure it lands.

## Do-not-touch list

- `src/*.bench.ts` — vitest v4 `bench` API, never refactor or bump.
- `src/bench-resources.ts` — shared benchmark fixtures.
- Root `tsconfig.json` — keep clean of bench exclusions (lint depends on it).
- Generated `build/` and `docs/` — produced by the build, not hand-edited.

## References

- `tsconfig-typedoc.json` — the typedoc-only config that excludes bench files.
- `scripts/pre-mode.mjs` — prerelease mode handling for the release.
- `.github/workflows/ci.yml` / `release.yml` — the verify and release pipelines.
