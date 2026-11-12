/**
 * Narrowing lookups for the tests: each returns the narrowed value or fails
 * the test, so a test body reads the result without a conditional, an early
 * return or a type assertion (#224).
 *
 * @module tests/helpers/narrow
 */

import * as P from "effect/Predicate";
import { expect } from "vite-plus/test";

/** `value` narrowed to the member tagged `tag`, failing the test when it is absent or tagged otherwise. */
export const expectTagged = <A extends { readonly _tag: string }, const T extends A["_tag"]>(
  value: A | null | undefined,
  tag: T,
): A & { readonly _tag: T } =>
  P.isTagged(value, tag) ? value : expect.unreachable(`expected ${tag}`);

/** `value` with `null` and `undefined` excluded, failing the test (naming `what`) when it is either. */
export const expectDefined = <A>(value: A | null | undefined, what: string): A =>
  P.isNotNullish(value) ? value : expect.unreachable(`${what} missing`);
