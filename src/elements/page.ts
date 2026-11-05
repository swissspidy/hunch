/**
 * `<inkling-page>`: records that the visitor viewed an item, and how long they stayed (with
 * consent). Renders nothing.
 *
 *   <inkling-page manifest="/inkling/manifest.json" item="post-42"></inkling-page>
 */

import { Inkling } from '../client/index.ts';
import { manifestOf } from './config.ts';
import { Base } from './slots.ts';

export class InklingPageElement extends Base {
  private stop: (() => void) | undefined;

  connectedCallback(): void {
    const manifest = manifestOf(this);
    const item = this.getAttribute('item');
    if (!manifest || !item) return;
    let stopped = false;
    this.stop = () => (stopped = true);
    Inkling.shared(manifest).then(
      (inkling) => {
        if (!stopped) this.stop = inkling.observe(item);
      },
      () => {},
    );
  }

  disconnectedCallback(): void {
    this.stop?.();
    this.stop = undefined;
  }
}
