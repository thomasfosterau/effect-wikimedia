---
"@thomasfosterau/effect-wikimedia": minor
---

`Reconciliation.WikidataLookup` is now keyed `"effect-wikimedia/WikidataLookup"`, in the package's namespace like `Core.WikimediaClient` (`"effect-wikimedia/Client"`), instead of the app-style `"@app/WikidataLookup"` it was ported with. Code that uses the `WikidataLookup` class is unaffected; code that provides or reads the service by the raw key string must switch to the new key.
