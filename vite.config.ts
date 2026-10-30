import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";
import { defineConfig } from "vite-plus";

/**
 * Vite+ configuration for the single package in this repository.
 *
 * The gates are Vite+ tasks rather than package.json scripts: a package.json
 * script can never be cached, however pure it is. The task names (`check`,
 * `test:unit`, `build`) match the other library repos (#20).
 */
export default defineConfig({
  // Staged-file checks run by `vp staged` (the pre-commit hook in
  // `.vite-hooks/`, installed by `vp config` in `prepare`).
  staged: {
    "*.{js,mjs,ts,json,md}": "vp check --fix",
  },
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
        cache: { input: [{ auto: true }, "!coverage/**"] },
      },
      // The family's name for the coverage run that `fallow audit` (the
      // PreToolUse fallow gate) reads for its CRAP scores: here it is
      // `test:unit` itself, which already writes coverage/coverage-final.json.
      "test:coverage": {
        command: "echo 'test:coverage: coverage/coverage-final.json written by test:unit'",
        dependsOn: ["test:unit"],
        cache: false,
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
    ignorePatterns: ["**/dist/**", "api-docs/**", "coverage/**", "tests/dist-consumer/**"],
    extends: [recommended, effect.configs.recommended],
    // Oxlint's default plugins plus the ones this codebase has code for:
    // `import` (ESM graph), `promise` (the Node stream adapters and tests),
    // `vitest` (the suite) and `jsdoc` (every export is documented).
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "vitest", "jsdoc"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    rules: {
      // `casting-awareness` is an awareness prompt, not a defect rule: it
      // fires on every `as`, including the narrowings the Fetch types
      // structurally require. Stays visible as a warning.
      "effect/casting-awareness": "warn",
      // Hard-codes abbreviations (`Arr`, `P`, `R`, …) with no options, so it is
      // unsatisfiable under the full-name convention (`import * as Option from
      // "effect/Option"`) this family shares with its consumers.
      "effect/prefer-namespace-imports": "off",
      // ---- Effect preset: rules this package's conventions cut across ------
      // `prefer-option-over-null` also fires on `?: T | undefined`, which is
      // the ONLY spelling of an optional member `exactOptionalPropertyTypes`
      // lets a caller forward an optional of its own into (AGENTS.md), and on
      // the `null` the Wikimedia APIs' JSON carries (decoded schemas mirror
      // the wire). A bare `null` / `undefined` in a return type is still a
      // finding to read; the options-object members are not.
      "effect/prefer-option-over-null": "warn",
      // `unknown` is the honest type at the boundaries this package sits on:
      // a caught failure turned into an error's `description`, and the raw
      // JSON a Wikimedia API returns before its schema decodes it.
      "effect/no-unknown-parameters": "warn",
      "effect/no-unsafe-dictionary-type": "warn",
      "effect/no-runtime-typeof": "warn",
      "vite-plus/prefer-vite-plus-imports": "error",
      // ---- Oxlint categories: rules this package's conventions cut across --
      // `_tag` is Effect's discriminator, on every tagged error and union this
      // package defines and matches.
      "no-underscore-dangle": "off",
      // Type assertions are governed by the Effect rules above
      // (`casting-awareness`, `require-safety-comment-for-type-assertion`),
      // which ask for the `// SAFETY:` reason this rule cannot see.
      "typescript/no-unsafe-type-assertion": "off",
      // A generic read-as-`A` helper over raw JSON (`objectsIn<A>`) uses its
      // type parameter once on purpose: the caller names the wire shape.
      "typescript/no-unnecessary-type-parameters": "off",
      // Vitest's `expect(value, message)` takes a failure message.
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      // Tests assert through `expect…` helpers and `assert`.
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "expect*", "assert", "assert*"] },
      ],
    },
    overrides: [
      // Build configs and the TypeDoc plugin are evaluated by Vite, Vitest and
      // TypeDoc in bare Node, before any Effect runtime exists: there is no
      // `FileSystem` service to call, so `node:*` and native loops are the
      // idiom there.
      {
        files: ["vite.config.ts", "scripts/**"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          "effect/imperative-loops": "off",
          "effect/no-length-comparison": "off",
          "effect/prefer-arr-match": "off",
          "effect/avoid-native-object-helpers": "off",
          "effect/use-console-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
        },
      },
      // The one Node-only module (AGENTS.md: "Node imports stay in
      // `src/dumps/sources.ts`"). Its contract is Node interop: it adapts
      // `node:fs` read streams and `node:zlib` / caller-supplied Node
      // decompressors into a `Stream<Uint8Array>`. An Effect `FileSystem`
      // service would need a platform layer this package does not depend on
      // and its callers would have to provide.
      {
        files: ["src/dumps/sources.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/use-filesystem-service": "off",
          // `attempt` (used by `adaptClassicDuplex`) runs inside a Node
          // Duplex's write callback, outside any Effect: a classic stream's
          // `write()` can throw synchronously (unbzip2-stream does on corrupt
          // input), and the throw must reach the write callback rather than
          // escape the stream. `Effect.try` there would need an
          // `Effect.runSync` (effect-run-in-body).
          "effect/avoid-try-catch": "off",
        },
      },
      // The wikitext parser's cursor drivers (`seek`, `repeatWhile`; #174):
      // every scan in the parser advances a mutable index through the source
      // and exits early, which `Arr` combinators can't express without
      // allocating per character, and recursion would overflow on dump-scale
      // articles. Each scan is written as one step that a driver here
      // repeats, so these two loops are the parser's only ones.
      {
        files: ["src/wikitext/cursor.ts"],
        rules: {
          "effect/imperative-loops": "off",
        },
      },
      // The perf test logs its measured timings to the CI log; it is
      // synchronous and runs no Effect, so there is no Console service to log
      // through.
      {
        files: ["tests/perf.test.ts"],
        rules: {
          "effect/use-console-service": "off",
        },
      },
      // Tests run in bare Node with no Effect platform layer: the package
      // depends on no `@effect/platform-node`, so there is no `FileSystem`,
      // `Path` or `ChildProcessSpawner` implementation to provide. Tests read
      // their recorded fixtures, write temporary dumps, drive esbuild
      // (`tree-shaking.test.ts`) and run the system `bzip2` with Node's own
      // modules, and feed real Node streams to the Node-only `Dumps` sources.
      {
        files: ["tests/**"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          "effect/use-temp-file-scoped": "off",
          "effect/use-command-executor-service": "off",
          // Test fixtures are the seams under test, not domain code: a
          // recorded payload narrowed to the shape a test asserts against.
          // Stays visible as a warning, because a fixture cannot be written
          // another way.
          "effect/require-safety-comment-for-type-assertion": "warn",
          // Each test is an entry point: it provides its stubbed layers once,
          // at the edge, which is what this diagnostic asks for.
          "effecttsgo/strict-effect-provide": "off",
          // Tests narrow a union with `if (!guard) return expect.unreachable(…)`
          // and then assert on the narrowed value; that return and the
          // assertions after it are the idiom, not a missing return or a
          // skipped assertion.
          "typescript/consistent-return": "off",
          "vitest/no-conditional-expect": "off",
          // A helper sits next to the one test that reads it, inside that
          // test's `describe`, so the test reads top to bottom.
          "unicorn/consistent-function-scoping": "off",
        },
      },
      // The unit suite's runtime boundary: `@effect/vitest`'s `it.effect`
      // cannot load under the Vite+ vitest (see the module comment), so these
      // helpers are where every test runs its Effect.
      {
        files: ["tests/helpers/effect.ts"],
        rules: {
          "effect/effect-run-in-body": "off",
        },
      },
    ],
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
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
