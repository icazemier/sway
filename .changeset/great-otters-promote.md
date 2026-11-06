---
"@icazemier/sway": patch
---

Promote the 2.3.1 beta line to stable. `2.3.1-beta.0` shipped the devDependency updates (vitest 5.1, eslint 10.14, typescript 6.0.3, @types/node 26, typedoc 0.28.20, typescript-eslint 8.72.1) and the minimatch override fixing CVE-2026-118764 (GHSA-g3hv-75wg-m249); npm audit is clean. No runtime dependencies are affected. This changeset graduates the line to `2.3.1` on `latest` via the `development → main` promotion.
