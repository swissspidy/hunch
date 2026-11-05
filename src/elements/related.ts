import type { Inkling, Recommendation } from '../client/index.ts';
import { SlotsElement } from './slots.ts';

/**
 * `<inkling-related>`: related items in server-rendered slots. Uses no visitor data.
 *
 * ```html
 * <inkling-related manifest="/inkling/manifest.json" item="post-42" section="science">
 *   <a data-inkling-slot data-inkling-id="post-41" href="/posts/41"><span data-inkling-title>…</span></a>
 *   …
 * </inkling-related>
 * ```
 *
 * Attributes: `manifest` and `item` (required), `section` (the item's section: its shard loads
 * first), `sections` (`same`, or a comma-separated list), `diversity`. The slots, states and
 * events are the module's.
 */
export class InklingRelatedElement extends SlotsElement {
  /** @internal Custom element lifecycle, called by the browser. */
  static get observedAttributes(): string[] {
    return ['item', 'manifest', 'sections', 'diversity'];
  }

  protected async recommend(inkling: Inkling, n: number): Promise<Recommendation[]> {
    const item = this.getAttribute('item');
    if (!item) throw new Error('<inkling-related> needs an item');
    return inkling.related(item, {
      n,
      sectionHint: this.getAttribute('section') ?? undefined,
      sections: this.getAttribute('sections') === 'same' ? 'same' : this.list('sections'),
      diversity: this.number('diversity'),
    });
  }
}
