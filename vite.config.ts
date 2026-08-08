import { defineConfig } from "vite-plus";

/**
 * Vite+ configuration for the single package in this repository.
 *
 * `build` / `test` are Vite+ tasks rather than package.json scripts: a
 * package.json script can never be cached, however pure it is.
 */
export default defineConfig({
  run: {
    cache: true,
    tasks: {
      build: "vp pack",
      test: "vp test run",
    },
  },

  /**
   * `vp pack` (tsdown) builds the publishable library.
   *
   * `unbundle` keeps a 1:1 mapping between source modules and output files, so
   * the module-per-surface boundary the package is built around survives into
   * `dist/` — a consumer importing `Action` still doesn't pull `Dumps`.
   * `tests/tree-shaking.test.ts` is what actually pins that property.
   *
   * `platform: "neutral"` because only the `Dumps` byte sources touch Node; the
   * rest must stay usable in a browser or a Worker.
   */
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "neutral",
    unbundle: true,
    dts: true,
    sourcemap: true,
    deps: {
      // Node builtins are imported only by `src/dumps/sources.ts`, the
      // sanctioned Node-only entry point.
      neverBundle: [/^node:/],
    },
  },

  /** `vp check` (Oxlint + tsgolint) */
  lint: {
    ignorePatterns: ["**/dist/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },

  /** `vp check` (Oxfmt) */
  fmt: {
    ignorePatterns: ["**/dist/**"],
  },

  /** `vp test` (Vitest) */
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts"],
    },
  },
});
