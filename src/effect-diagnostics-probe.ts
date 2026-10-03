/**
 * Deliberate Effect diagnostic probe for #31: a floating Effect is an
 * `error`-severity `floatingEffect` diagnostic. Reverted in the next commit.
 *
 * @module
 */
import * as Effect from "effect/Effect";

/** Probe only: never runs the Effect it builds. */
export const probe = (): void => {
  Effect.log("probe");
};
