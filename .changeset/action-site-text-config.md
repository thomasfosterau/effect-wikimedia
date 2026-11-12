---
"@thomasfosterau/effect-wikimedia": patch
---

Action: `getSiteTextConfig(host)` fetches a wiki's `hiddenLinkPrefixes` and `redirectAliases` in one siteinfo request (#220). `getHiddenLinkPrefixes` and `getRedirectAliases` each make one request of their own. The new call is backed by `SiteTextConfigResponse` and `normaliseSiteTextConfig`, and the two existing calls are unchanged.
