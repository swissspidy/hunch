/**
 * Inkling's web components, registered on import: `<inkling-related>`, `<inkling-for-you>`,
 * `<inkling-page>` and `<inkling-digest>`. Call `Inkling.configure({ consent })` before
 * importing this module if the components should personalize.
 *
 * The list components (`related`, `for-you`, `digest`) fill server-rendered slots. The server
 * renders a fixed number of slots (`[data-inkling-slot]`) holding a fallback. Once the browser
 * is idle, the element ranks items and replaces each slot with a copy of it whose link, title,
 * section, date and image are the ranked item's (`[data-inkling-href]` or the first `a`,
 * `[data-inkling-title]`, `[data-inkling-section]`, `[data-inkling-date]`,
 * `img[data-inkling-image]`). Give the slots a fixed height and clamp titles to a fixed number
 * of lines, and nothing shifts. Listeners attached to a slot do not carry over to its copy:
 * delegate them to the element. When there are fewer results than slots, the rest are hidden.
 * While a slot holds focus, the element waits for focus to leave before it replaces the slots.
 *
 * State: `data-inkling-state` is `loading`, `ready` or `error` (the fallback stays). Events:
 * `inkling:ready` (detail: `{ recommendations }`) and `inkling:error` (detail: `{ error }`). A
 * click on a slot whose `data-inkling-id` is set records a `click` signal (with consent).
 *
 * @module @swissspidy/inkling/elements
 */

import { defineElements } from './define.ts';

defineElements();

export { defineElements } from './define.ts';
export { InklingDigestElement } from './digest.ts';
export { InklingForYouElement } from './for-you.ts';
export { InklingPageElement } from './page.ts';
export { InklingRelatedElement } from './related.ts';
