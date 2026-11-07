import { Hunch } from '../client/index.ts';
import { manifestOf } from './config.ts';
import { Base } from './slots.ts';

/**
 * `<hunch-page>`: records that the visitor viewed an item, and how long they stayed (with
 * consent). Renders nothing.
 *
 * ```html
 * <hunch-page manifest="/hunch/manifest.json" item="post-42"></hunch-page>
 * ```
 */
export class HunchPageElement extends Base {
  private stop: (() => void) | undefined;

  /** @internal Custom element lifecycle, called by the browser. */
  connectedCallback(): void {
    const manifest = manifestOf(this);
    const item = this.getAttribute('item');
    if (!manifest || !item) return;
    let stopped = false;
    this.stop = () => (stopped = true);
    Hunch.shared(manifest).then(
      (hunch) => {
        if (!stopped) this.stop = hunch.observe(item);
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
