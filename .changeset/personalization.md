---
'@swissspidy/inkling': minor
---

Personalization (milestone 2): with the site's consent hook (`consent`, `Inkling.configure()` or `window.InklingConfig`), the client records view, click, dwell, follow and hide signals in IndexedDB, derives a profile from them on every page, and ranks "for you" with `recommend()` and `rank()`. `explain()` and every result's `why.because` say which of the visitor's items a recommendation leans on. `pause()`, `resume()`, `export()` and `forget()` are the visitor's controls. New components: `<inkling-for-you>` and `<inkling-page>`.
