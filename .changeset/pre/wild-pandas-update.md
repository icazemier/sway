---
"@icazemier/sway": patch
---

Update all devDependencies to their latest versions (vitest + @vitest/coverage-v8 5.1.0, eslint 10.14.0, typescript 6.0.3, typescript-eslint 8.72.1, typedoc 0.28.20, @types/node 26.6.6, eslint-plugin-prettier 5.5.7) and add an npm override pinning transitive minimatch to ^11.0.1, fixing CVE-2026-118764 / GHSA-g3hv-75wg-m249 (globparts amplification DoS). `npm audit` is now clean (0 vulnerabilities). No runtime dependencies are affected; sway still ships zero runtime deps. TypeScript stays on 6.x because typedoc 0.28.x and typescript-eslint 8.x do not support TS 7 yet.
