---
'@swissspidy/inkling': patch
---

The list components no longer drop keyboard focus: while a slot holds focus, `<inkling-related>`, `<inkling-for-you>` and `<inkling-digest>` wait for it to leave before replacing the slots. An `aria-label` on a slot or its link that contains the fallback item's title now gets the new item's title, so the link's accessible name matches what it shows.
