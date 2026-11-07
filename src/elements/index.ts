/**
 * Hunch's web components, registered on import: `<hunch-related>`, `<hunch-for-you>`,
 * `<hunch-page>` and `<hunch-digest>`. Call `Hunch.configure({ consent })`, or set
 * `window.HunchConfig`, before importing this module if the components should personalize.
 *
 * The list components (`related`, `for-you`, `digest`) fill server-rendered slots. The server
 * renders a fixed number of slots (`[data-hunch-slot]`) holding a fallback. Once the browser
 * is idle, the element ranks items and replaces each slot with a copy of it whose link, title,
 * section, date and image are the ranked item's (`[data-hunch-href]` or the first `a`,
 * `[data-hunch-title]`, `[data-hunch-section]`, `[data-hunch-date]`,
 * `img[data-hunch-image]`). Give the slots a fixed height and clamp titles to a fixed number
 * of lines, and nothing shifts. Listeners attached to a slot do not carry over to its copy:
 * delegate them to the element. When there are fewer results than slots, the rest are hidden.
 * While a slot holds focus, the element waits for focus to leave before it replaces the slots.
 *
 * State: `data-hunch-state` is `loading`, `ready` or `error` (the fallback stays). Events:
 * `hunch:ready` (detail: `{ recommendations }`) and `hunch:error` (detail: `{ error }`). A
 * click on a slot whose `data-hunch-id` is set records a `click` signal (with consent).
 *
 * @module @swissspidy/hunch/elements
 */

import { defineElements } from './define.ts';

defineElements();

export type { HunchConfig } from './config.ts';
export { defineElements } from './define.ts';
export { HunchDigestElement } from './digest.ts';
export { HunchForYouElement } from './for-you.ts';
export { HunchPageElement } from './page.ts';
export { HunchRelatedElement } from './related.ts';
