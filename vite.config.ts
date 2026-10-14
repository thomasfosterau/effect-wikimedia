import { defineConfig } from "vite-plus";

/**
 * Vite+ configuration for the single package in this repository.
 *
 * The gates are Vite+ tasks rather than package.json scripts: a package.json
 * script can never be cached, however pure it is. The task names (`check`,
 * `test:unit`, `build`) match the other library repos (#20).
 */
export default defineConfig({
  run: {
    cache: true,
    tasks: {
      // The TS 7 type check plus Effect diagnostics (#20, #31). `vp check`
      // type-checks with tsgolint, which reports no Effect diagnostics;
      // `prepare` patches the native `tsc` (`@typescript/native`) with
      // `effect-tsgo`, so this is the gate that fails on an Effect `error`
      // diagnostic (warnings and suggestions print but don't fail it:
      // `ignoreEffectWarningsInTscExitCode` in tsconfig.json). `vp run` puts
      // this package's `node_modules/.bin` first on PATH, so the bare `tsc` is
      // always the patched one. Not to be confused with `vp check`, the Vite+
      // built-in (Oxfmt + Oxlint + tsgolint).
      check: "tsc -p tsconfig.json",
      build: "vp pack",
      // `--coverage` writes coverage/coverage-final.json (the `json` reporter
      // below), which `fallow:health` reads for its CRAP scores. Istanbul's
      // instrumentation adds about two seconds to the suite. Vitest reads
      // back its own `coverage/.tmp/` shards, and a task that reads what it
      // wrote is never cached, so `coverage/` is left out of the fingerprint;
      // it is still archived as output and restored on a cache hit. Vitest
      // also lists the root directory, so a run that starts without
      // `coverage/` misses: in CI, where every checkout starts without it,
      // the Test step always reruns the suite, and `fallow:health` then hits.
      "test:unit": {
        command: "vp test run --coverage",
        input: [{ auto: true }, "!coverage/**"],
      },
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
      // The dead-code and duplication gate (#20, #102), fallow's static
      // analyses. `dead-code` fails on an unused file, export, type,
      // devDependency or catalog entry, a duplicate export, an unresolved
      // import or a circular dependency; entry points and the documented
      // exemptions live in `.fallowrc.json`, and the exports on `src/index.ts`
      // are the published surface, so they always count as used. `dupes`
      // exits 0 on findings unless given `--fail-on-issues`; with it, any
      // clone group not in `duplicates.ignoredClones` fails. `--no-cache` keeps
      // fallow's own cache out of the tree, so the Vite+ task cache alone
      // decides what reruns.
      fallow: {
        command: ["fallow dead-code --no-cache", "fallow dupes --no-cache --fail-on-issues"],
      },
      // The complexity ratchet (#102): fails on a function over a cyclomatic,
      // cognitive or CRAP ceiling (`health` in `.fallowrc.json`: the defaults,
      // plus a pinned ceiling for each function already over one). CRAP needs
      // the coverage that `test:unit` writes, hence the dependency; in CI it
      // replays from the Test step, cached outputs included. `--complexity`
      // limits the run to the function findings that decide the exit code:
      // the default report adds git-churn hotspots, which read history the
      // task cache doesn't fingerprint.
      "fallow:health": {
        command: "fallow health --no-cache --complexity",
        dependsOn: ["test:unit"],
      },
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

  /** `vp test` (Vitest), which the `test:unit` task runs */
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "istanbul",
      // `json` writes coverage-final.json for `fallow:health`.
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts"],
    },
  },
});
