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
      // The dist-consumer declaration check (#20): type-check
      // `tests/dist-consumer/` against the emitted `dist/*.d.ts`, so broken
      // published types fail even when the source type-check passes. Both
      // compilers a consumer may run: TS 7 (`tsc`, what `typescript` installs
      // today) and TS 6 (`tsc6`, the JS compiler behind editors and
      // declaration tooling until TS 7.1 ships a JS API). The fixture's
      // tsconfig carries no Effect plugin, so the patched `tsc` checks it as
      // stock TS 7 would.
      "check:dist": {
        command: [
          "tsc -p tests/dist-consumer/tsconfig.json",
          "tsc6 -p tests/dist-consumer/tsconfig.json",
        ],
        dependsOn: ["build"],
      },
      // The docs gate (#20): TypeDoc renders the API reference from the doc
      // comments reachable from `src/index.ts` into the gitignored `api-docs/`
      // and fails on an undocumented export or a `{@link}` that resolves to
      // nothing in the published surface. Settings live in `typedoc.json`;
      // `tsdoc.json` registers the `@copyright` tag. Reads `src/` through the
      // TS 6 JS API, so it needs no build.
      docgen: "typedoc",
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
      // Node builtins are imported only by `src/dumps/sources.ts`, the one
      // Node-only module.
      neverBundle: [/^node:/],
    },
  },

  /** `vp check` (Oxlint + tsgolint) */
  lint: {
    // `tests/dist-consumer/` resolves the package through the built `dist/`,
    // which doesn't exist yet when `vp check` runs; `check:dist` type-checks it
    // after the build instead.
    ignorePatterns: ["**/dist/**", "api-docs/**", "tests/dist-consumer/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },

  /** `vp check` (Oxfmt) */
  fmt: {
    ignorePatterns: ["**/dist/**", "api-docs/**"],
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
