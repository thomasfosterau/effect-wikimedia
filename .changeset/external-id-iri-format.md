---
"@thomasfosterau/effect-wikimedia": minor
---

`Reconciliation.EXTERNAL_ID_AUTHORITIES` now checks each identifier against its authority's format before building the IRI, and percent-encodes it into a single path segment. Before, a value such as a P214 (VIAF) claim of `../../x` built `https://viaf.org/viaf/../../x`, which resolves to `https://viaf.org/x`. Each entry's `iri` now returns `string | null` (typed by the new `Reconciliation.ExternalIdAuthority`): it returns `null` for a value outside the authority's identifier format (VIAF, ISNI, ORCID, LCCN, GND, BnF; each at least as permissive as the property's Wikidata format constraint, with LCCN in the Library of Congress's normalised form), and `WikidataLookup.enrich` emits no `sameAs` fact for such a value. ISNI values in Wikidata's spaced form (`0000 0001 2103 2683`) now build the compact IRI `https://isni.org/isni/0000000121032683` instead of an IRI containing spaces.
