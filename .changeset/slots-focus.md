---
'@swissspidy/hunch': patch
---

The list components keep keyboard focus: while a slot holds focus, `<hunch-related>`, `<hunch-for-you>` and `<hunch-digest>` wait for it to leave before replacing the slots. An `aria-label` on a slot or its link that contains the fallback item's title gets the new item's title, so the link's accessible name matches what it shows.
