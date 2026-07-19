/**
 * @copyright Thomas Foster
 *
 * `@thomasfosterau/effect-wikimedia` — a strongly typed, Effect-idiomatic
 * client family for Wikimedia properties (Wikipedia, Wikidata, Commons, and
 * siblings). One package, **module-per-surface**: each namespace below is a
 * tree-shakeable slice that imports only {@link Core} — importing `Action`
 * never pulls `Rest` or `Commons` into a bundle. See
 * `docs/decisions/effect-wikimedia-as-the-wikimedia-client-toolkit.md` for
 * the design this package follows and why.
 *
 * - **`Core`** — the shared `HttpClient`-based service (`WikimediaClient`),
 *   per-wiki host validation, the typed error family, and the polite-UA /
 *   `maxlag` / retry-after etiquette every surface module builds on.
 * - **`Action`** — the Action API (`/w/api.php`): page wikitext, page
 *   metadata, search, and the `parse` endpoint's typed sections / links /
 *   categories / templates.
 * - **`Rest`** — the Core REST API / Parsoid surface (`/w/rest.php/v1/...`):
 *   parsed HTML for a title or revision, typed page/revision metadata.
 * - **`Commons`** — Commons file info and `Special:FilePath` URL
 *   construction (subsumes `packages/wikidata`'s `normaliseCommonsImage`).
 *
 * Zero website-internal dependencies anywhere in this package — designed
 * from day one for extraction to its own repository/npm package.
 *
 * @module index
 */

export * as Action from "./action";
export * as Commons from "./commons";
export * as Core from "./core";
export * as Rest from "./rest";
