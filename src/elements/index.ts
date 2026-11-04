/** Registers Inkling's example web components (a no-op during server rendering). */

import { InklingRelatedElement } from './related.ts';

if (globalThis.customElements && !customElements.get('inkling-related')) {
  customElements.define('inkling-related', InklingRelatedElement);
}

export { InklingRelatedElement, inklingFor } from './related.ts';
