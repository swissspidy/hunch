---
'@swissspidy/hunch': minor
---

"Since your last visit": the client records visits with consent (`visit()`; a visit ends after `visitGapMinutes` without activity), and `sinceLastVisit()` ranks the items published since the previous one. `recommend()` accepts `after`. The new `<hunch-digest>` component fills server-rendered slots with them, and adds a one-line summary from the browser's built-in Summarizer where its on-device model is available. The Summarizer helpers are in `@swissspidy/hunch/digest`.
