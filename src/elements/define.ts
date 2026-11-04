import { InklingForYouElement } from './for-you.ts';
import { InklingPageElement } from './page.ts';
import { InklingRelatedElement } from './related.ts';

/** Registers the components (a no-op during server rendering, and for names already taken). */
export function defineElements(): void {
  if (!globalThis.customElements) return;
  for (const [name, element] of [
    ['inkling-related', InklingRelatedElement],
    ['inkling-for-you', InklingForYouElement],
    ['inkling-page', InklingPageElement],
  ] as const) {
    if (!customElements.get(name)) customElements.define(name, element);
  }
}
