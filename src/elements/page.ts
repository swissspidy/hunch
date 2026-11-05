import { Inkling } from '../client/index.ts';
import { manifestOf } from './config.ts';
import { Base } from './slots.ts';

/**
 * `<inkling-page>`: records that the visitor viewed an item, and how long they stayed (with
 * consent). Renders nothing.
 *
 * ```html
 * <inkling-page manifest="/inkling/manifest.json" item="post-42"></inkling-page>
 * ```
 */
export class InklingPageElement extends Base {
  private stop: (() => void) | undefined;

  /** @internal Custom element lifecycle, called by the browser. */
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

  /** @internal Custom element lifecycle, called by the browser. */
  disconnectedCallback(): void {
    this.stop?.();
    this.stop = undefined;
  }
}
