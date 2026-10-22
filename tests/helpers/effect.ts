/**
 * Repo-owned Effect test helpers for the unit suite.
 *
 * Why not `@effect/vitest`: its `describe`/`it` wrappers read vitest
 * internals that the repo's vitest alias (`@voidzero-dev/vite-plus-test`,
 * see package.json `"vitest"`) does not expose — importing it fails at
 * module evaluation with `TypeError: Cannot read properties of undefined
 * (reading 'config')` (verified June 2026 against
 * `@effect/vitest@4.0.0-beta.78`). Revisit if the alias gains vitest-API
 * parity; until then these two functions are the sanctioned shape, and
 * the integration suite keeps its own transaction-rollback harness
 * (`tests/integration/harness.ts`).
 *
 * Provide layers per test with `Effect.provide` at the call site:
 *
 * ```ts
 * const exit = await runTestExit(requireAdmin.pipe(Effect.provide(layer)));
 * ```
 *
 * @module tests/unit/helpers/effect
 */

import { expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

/** Run a fully-provided Effect to a Promise of its success value. */
export const runTest = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect);

/** Run a fully-provided Effect to its `Exit`, for failure-path assertions. */
export const runTestExit = <A, E>(effect: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect);

/**
 * Run a fully-provided Effect expected to fail with an instance of the
 * given error class; returns the failure, typed as that class, so callers
 * can assert on its fields.
 */
export const expectFailureInstanceOf = async <
  A,
  E,
  C extends abstract new (...args: never[]) => object,
>(
  program: Effect.Effect<A, E, never>,
  errorClass: C,
): Promise<InstanceType<C>> => {
  const exit = await runTestExit(program);

  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return expect.unreachable("Expected a failure exit");
  const failure = Option.match(Cause.findErrorOption(exit.cause), {
    onNone: () => expect.unreachable("Expected a typed failure in the cause"),
    onSome: (error) => error,
  });
  expect(failure).toBeInstanceOf(errorClass);
  const isInstance = (error: E): error is E & InstanceType<C> => error instanceof errorClass;
  if (!isInstance(failure)) return expect.unreachable("Unexpected failure class");
  return failure;
};
