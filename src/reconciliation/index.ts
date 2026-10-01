/**
 * The opinionated reconciliation layer over `Action` and `Wikidata`: resolve a
 * label or an external identifier to candidate Wikidata items (Match), then
 * pull the selected facts for a confirmed QID (Enrich).
 *
 * @module reconciliation
 */

export * from "./candidate.ts";
export * from "./lookup.ts";
export * from "./normalise.ts";
