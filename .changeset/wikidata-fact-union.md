---
"@thomasfosterau/effect-wikimedia": minor
---

`Reconciliation.WikidataFact` is now a union tagged by fact kind, built from `Schema` tagged structs, and drops the `mappingKind` and `notes` fields, which came from the website's mapping table. `WikidataLookup.enrich` returns, in order, one `Item` fact for the confirmed QID, then `Identifier`, `Date` and `Image` facts. `Reconciliation.WikidataFact` is also a schema with `match`, `guards` and `isAnyOf`, and each variant is exported as a schema and a type: `ItemFact`, `IdentifierFact`, `DateFact` and `ImageFact`.

To migrate, branch on `_tag` instead of `authority` and `notes`:

- QID self-link (`authority: "wikidata"`, `mappingKind: "exact"`): now `{ _tag: "Item", qid, iri }`, where `qid` was `externalId` and `iri` was `externalIri`.
- `sameAs` identifier (`mappingKind: "exact"`): now `{ _tag: "Identifier", property, authority, value, iri }`, where `value` was `externalId`, `iri` was `externalIri`, and `property` (e.g. `"P214"`) is new.
- Date (`notes` such as `"date of birth"`): now `{ _tag: "Date", property, label, time, precision }`, where `time` was `externalId`, `label` was `notes`, and `property` replaces `externalIri` (`wikidataEntityIri(property)` rebuilds the old value). `precision` is new: Wikibase's 0–14 precision code (9 = year, 11 = day), or `null`.
- Image (`authority: "wikimedia-commons"`, `notes: "image"`): now `{ _tag: "Image", property, filename, iri }`, where `filename` was `externalId` and `iri` was `externalIri`.
