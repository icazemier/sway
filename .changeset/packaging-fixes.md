---
'@icazemier/sway': patch
---

Fix `require('@icazemier/sway')` throwing `Cannot use import statement outside a module`. The CommonJS build was emitted as ESM and labelled as CommonJS, so every CJS consumer failed at load time.

The published tarball no longer carries the internal profiling script, `exports` declares explicit `types` conditions for both module systems, and the JSR package ships only its sources instead of the whole repository.
