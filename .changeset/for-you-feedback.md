---
'@swissspidy/hunch': minor
---

`<hunch-for-you>` slots can say why an item is there and let the visitor hide it. A `[data-hunch-because]` element gets "Because you read …" (the `because` attribute sets the text) when the profile placed the item and the item it names is close to it (`because-min`, default 0.35). A `[data-hunch-hide]` button, shown only with consent, records a `hide` signal; the list then ranks again, focus moves to the same slot's link, and a `[data-hunch-announce]` live region gets its `data-message`. Each `why.because` entry has `similarity`, its cosine similarity to the recommended item.
