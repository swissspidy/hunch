import { applyPageConfig } from './config.ts';
import { InklingDigestElement } from './digest.ts';
import { InklingForYouElement } from './for-you.ts';
import { InklingPageElement } from './page.ts';
import { InklingRelatedElement } from './related.ts';

/**
 * Applies `window.InklingConfig` and registers the components (a no-op during server rendering,
 * and for names already taken).
 */
export function defineElements(): void {
  if (!globalThis.customElements) return;
  // Before registering: that upgrades the components already in the page.
  applyPageConfig();
  for (const [name, element] of [
    ['inkling-related', InklingRelatedElement],
    ['inkling-for-you', InklingForYouElement],
    ['inkling-page', InklingPageElement],
    ['inkling-digest', InklingDigestElement],
  ] as const) {
    if (!customElements.get(name)) customElements.define(name, element);
  }
}
