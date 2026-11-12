import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";
import * as R from "effect/Record";
import { defineConfig } from "vite-plus";

/** The Oxlint config shape the presets share, named without depending on `oxlint` directly. */
type OxlintConfig = typeof recommended;

/**
 * `config` with every rule it sets to `warn` raised to `error`: this package
 * has no warn tier (#224), so a preset's advisory rules gate like the rest.
 * A rule this config relaxes is turned `off` below, scoped, with its reason.
 */
const atError = (config: OxlintConfig): OxlintConfig => ({
  ...config,
  rules: R.map(config.rules ?? {}, (setting) =>
    setting === "warn"
      ? "error"
      : Array.isArray(setting) && setting[0] === "warn"
        ? ["error", ...setting.slice(1)]
        : setting,
  ),
});

/**
 * Vite+ configuration for the single package in this repository.
 *
 * The gates are Vite+ tasks rather than package.json scripts: a package.json
 * script can never be cached, however pure it is. The task names (`check`,
 * `test:unit`, `build`) match the other library repos (#20).
 */
export default defineConfig({
  // Staged-file checks run by `vp staged` (the pre-commit hook in
  // `.vite-hooks/`, installed by `vp config` in `prepare`). Format with
  // fixes, lint without: lint is type-aware, and `vp check --fix` would apply
  // the autofixes of type-aware rules (even ones at `warn`) to the staged
  // files at commit time, so the commit would differ from the tree that was
  // verified (#225).
  // JSON and Markdown are formatted only: lint has nothing to check in them,
  // and `vp check --no-fmt` fails with "No files found to lint" when they
  // are the only files staged.
  staged: {
    "*.{js,mjs,ts}": ["vp check --fix --no-lint", "vp check --no-fmt"],
    "*.{json,md}": "vp check --fix --no-lint",
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
      // Every gate, in CI's order: the one command the CI workflow runs, so a
      // local `vp run ci` and CI are the same thing (AGENTS.md "Verification").
      // Static checks first (format, lint and type-check; the Effect
      // diagnostics; dead code and duplication), then the tests and the
      // complexity ratchet that reads their coverage, then the published
      // surface (build, the dist-consumer declarations, the API docs), and the
      // audit last as the one step that needs the npm registry. Each command
      // runs only if the one before it passed.
      ci: {
        command: [
          "vp check",
          "vp run check",
          "vp run fallow",
          "vp run test:unit",
          "vp run fallow:health",
          "vp run build",
          "vp run check:dist",
          "vp run docgen",
          "pnpm audit --audit-level high",
        ],
        cache: false,
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
    extends: [atError(recommended), atError(effect.configs.recommended)],
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
      // Every rule is an error (#224): no warn tier and no disable comments.
      // The only exceptions are the scoped overrides below, each a site the
      // rule cannot apply to, with the reason beside it.
      "effect/casting-awareness": "error",
      "effect/prefer-option-over-null": "error",
      "effect/no-unknown-parameters": "error",
      // Effect 4 marks much of `effect/http`, `effect/rpc` and `@effect/vitest`
      // `@stability unstable`, so this fires on nearly every client, worker
      // and test call and reports the pinned API, not a defect. The owner's
      // decision (#26) is that it is informational: a suggestion in
      // tsconfig.json's language-service options, and off here, where Oxlint
      // has no suggestion level. The sibling library repos do the same.
      "effecttsgo/unstable-api-usage": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
      "effect/no-conditional-empty-object-spread": "error",
      // Effects run and get their layers at the edge (#224): in `src/` that is
      // the caller, in tests it is `@effect/vitest` (`it.effect`, `it.live`,
      // `layer(...)`), so no module, test or helper calls `Effect.provide`
      // inside a program or `Effect.run*` itself. No exceptions.
      "effecttsgo/strict-effect-provide": "error",
      // Decode with the typed decoders (`decodeEffect`, `decodeSync`, `decodeOption`) so the input is checked against the schema's Encoded type (#224).
      "effecttsgo/prefer-typed-schema-decoder": "error",
      // Wire numbers are ids, counts and sizes: `Schema.Int` (or
      // `Schema.Finite`), never a `Schema.Number` that admits NaN and
      // Infinity (#224). No exceptions.
      "effecttsgo/schema-number": "error",
      // Every Schema class and tagged error carries a `{ readonly brand: unique
      // symbol }` second type argument (#224), so structurally identical
      // classes stay distinct types. No exceptions.
      "effecttsgo/schema-class-missing-brand": "error",
      "effect/effect-run-in-body": "error",
      "no-underscore-dangle": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "typescript/no-unnecessary-type-parameters": "error",
      // Vitest's `expect(value, message)` takes a failure message.
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      // Tests assert through `expect…` helpers and `assert`.
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "expect*", "assert", "assert*"] },
      ],
      // `@effect/vitest`'s Effect tests are test blocks too (#224): an
      // `expect` inside one is not standalone.
      "vitest/no-standalone-expect": [
        "error",
        {
          additionalTestBlockFunctions: [
            // A plain test in a `layer(...)` block, on the block's own `it`.
            "it",
            "it.each",
            "it.effect",
            "it.effect.each",
            "it.effect.skipIf",
            "it.live",
            "it.live.each",
            "it.live.skipIf",
          ],
        },
      ],
    },
    overrides: [
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
          // `asNodeDuplex` checks a caller's decompressor with Node's
          // `stream.isReadable` / `isWritable` before returning it as a
          // `Duplex`. Those take a `Readable` / `Writable`, not the
          // structural `NodeDuplexLike` the caller supplies, so the value has
          // to be viewed as a `Duplex` to be checked at all; a guard typed
          // `stream is Duplex` would need the same assertion inside it (#265).
          "effect/casting-awareness": "off",
          "typescript/no-unsafe-type-assertion": "off",
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
      // The two test files whose subject is Node itself. `sources.test.ts`
      // exercises the Node-only `Dumps` sources, so it feeds them real
      // `node:fs` / `node:stream` / `node:zlib` objects, spies on
      // `fs.ReadStream.prototype`, and pins their types against
      // `createGunzip`'s; an Effect `FileSystem` stream is not a Node
      // `Readable` and cannot stand in for them. `entities.test.ts` forces a
      // garbage collection through a `node:vm` context created while `node:v8`
      // has `--expose-gc` on, to measure retained heap; Effect has no service
      // for V8 flags or VM contexts.
      {
        files: ["tests/dumps/sources.test.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/use-filesystem-service": "off",
        },
      },
      {
        files: ["tests/dumps/entities.test.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
        },
      },
      {
        files: ["tests/**"],
        rules: {
          // `@effect/vitest`'s `layer(...)` hands each block its own `it`,
          // which carries the block's services, so a block's `it` shadows the
          // module's by design (#224).
          "no-shadow": ["error", { allow: ["it"] }],
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
