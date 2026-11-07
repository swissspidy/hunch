import type { Hunch, Recommendation } from '../client/index.ts';
import { SlotsElement } from './slots.ts';

/**
 * `<hunch-related>`: related items in server-rendered slots. Uses no visitor data.
 *
 * ```html
 * <hunch-related manifest="/hunch/manifest.json" item="post-42" section="science">
 *   <a data-hunch-slot data-hunch-id="post-41" href="/posts/41"><span data-hunch-title>…</span></a>
 *   …
 * </hunch-related>
 * ```
 *
 * Attributes: `item` and `manifest` (or `HunchConfig.manifest`), `section` (the item's
 * section: its shard loads first), `sections` (`same`, or a comma-separated list), `diversity`.
 * The slots, states and events are the module's.
 */
export class HunchRelatedElement extends SlotsElement {
  /** @internal Custom element lifecycle, called by the browser. */
  static get observedAttributes(): string[] {
    return ['item', 'manifest', 'sections', 'diversity'];
  }

  protected async recommend(hunch: Hunch, n: number): Promise<Recommendation[]> {
    const item = this.getAttribute('item');
    if (!item) throw new Error('<hunch-related> needs an item');
    return hunch.related(item, {
      n,
      sectionHint: this.getAttribute('section') ?? undefined,
      sections: this.getAttribute('sections') === 'same' ? 'same' : this.list('sections'),
      diversity: this.number('diversity'),
    });
  }
}
