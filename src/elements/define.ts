import { applyPageConfig } from './config.ts';
import { HunchDigestElement } from './digest.ts';
import { HunchForYouElement } from './for-you.ts';
import { HunchPageElement } from './page.ts';
import { HunchRelatedElement } from './related.ts';

/**
 * Applies `window.HunchConfig` and registers the components (a no-op during server rendering,
 * and for names already taken).
 */
export function defineElements(): void {
  if (!globalThis.customElements) return;
  // Before registering: that upgrades the components already in the page.
  applyPageConfig();
  for (const [name, element] of [
    ['hunch-related', HunchRelatedElement],
    ['hunch-for-you', HunchForYouElement],
    ['hunch-page', HunchPageElement],
    ['hunch-digest', HunchDigestElement],
  ] as const) {
    if (!customElements.get(name)) customElements.define(name, element);
  }
}
