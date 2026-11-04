/**
 * Inkling's example web components, registered on import. Call `Inkling.configure({ consent })`
 * before importing this module if the components should personalize.
 */

import { defineElements } from './define.ts';

defineElements();

export { defineElements } from './define.ts';
export { InklingDigestElement } from './digest.ts';
export { InklingForYouElement } from './for-you.ts';
export { InklingPageElement } from './page.ts';
export { InklingRelatedElement } from './related.ts';
