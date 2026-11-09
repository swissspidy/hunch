---
'@swissspidy/hunch': minor
---

List components fire `hunch:click`, which bubbles, when a slot is clicked: `detail` is `{ id, url, position, list, personalized }`. With `hunch:ready` (an impression), a site can count recommendation clicks in its own analytics. Hunch sends neither event anywhere.
