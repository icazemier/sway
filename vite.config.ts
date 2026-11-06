import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    benchmark: {
      // Restrict benchmarks to src/ so the typedoc-generated copy in
      // docs/media/ (created by `npm run build` → `npm run docs`) is not
      // picked up and failed on its unresolved `./sway.js` import.
      include: ['src/**/*.bench.ts'],
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.bench.ts',
        'src/interfaces.ts',
        'src/index.ts',
      ],
    },
  },
});
