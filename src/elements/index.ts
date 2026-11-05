/**
 * Inkling's example web components, registered on import. Call `Inkling.configure({ consent })`,
 * or set `window.InklingConfig`, before importing this module if the components should
 * personalize.
 */

import { defineElements } from './define.ts';

defineElements();

export type { InklingConfig } from './config.ts';
export { defineElements } from './define.ts';
export { InklingDigestElement } from './digest.ts';
export { InklingForYouElement } from './for-you.ts';
export { InklingPageElement } from './page.ts';
export { InklingRelatedElement } from './related.ts';
