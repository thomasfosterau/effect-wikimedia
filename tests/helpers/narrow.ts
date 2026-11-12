/**
 * Narrowing lookups for the tests: each returns the narrowed value or fails
 * the test, so a test body reads the result without a conditional, an early
 * return or a type assertion (#224).
 *
 * @module tests/helpers/narrow
 */

import * as P from "effect/Predicate";
import { expect } from "vite-plus/test";

/**
 * `value` narrowed to the member tagged `tag`, failing the test when it is
 * absent or tagged otherwise. `A` may include `undefined` (an array index, an
 * optional chain), which the narrowing removes.
 */
export const expectTagged = <A, const T extends string>(
  value: A,
  tag: T,
): NonNullable<A> & { readonly _tag: T } =>
  P.isTagged(value, tag) ? value : expect.unreachable(`expected ${tag}`);

/**
 * `value` with `null` and `undefined` removed from its type, failing the test
 * (naming `what`) when it is either.
 */
export const expectDefined = <A>(value: A, what: string): NonNullable<A> =>
  P.isNotNullish(value) ? value : expect.unreachable(`${what} missing`);
