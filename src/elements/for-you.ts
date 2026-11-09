import type { Hunch, Recommendation } from '../client/index.ts';
import { SlotsElement } from './slots.ts';

/**
 * `<hunch-for-you>`: the visitor's recommendations in server-rendered slots.
 *
 * The server renders the site's own order (the cold start). Without consent or signals the
 * slots stay exactly as they are; with a profile, they are replaced by its recommendations.
 * If the visitor hid an item the fallback shows, the catalog's own order without it is shown.
 * `data-hunch-personalized` says which happened.
 *
 * ```html
 * <hunch-for-you manifest="/hunch/manifest.json">
 *   <li data-hunch-slot data-hunch-id="post-1">
 *     <a href="/posts/1"><span data-hunch-title>…</span></a>
 *     <span data-hunch-because></span>
 *     <button type="button" data-hunch-hide hidden aria-label="Not interested: …">×</button>
 *   </li>
 *   …
 * </hunch-for-you>
 * ```
 *
 * Two optional parts of a slot, for the visitor:
 *
 * - `[data-hunch-because]` gets "Because you read …", when the profile placed the item (most of
 *   its score is similarity). It names the read item the recommendation leans on most among
 *   those close to it: cosine similarity at least `because-min` (default 0.35, which separates
 *   related from unrelated articles with EmbeddingGemma at 256 dimensions). Otherwise it is
 *   emptied. The `because` attribute is the text, with `{title}` for the item's title (default
 *   `Because you read {title}`). Give the element a fixed height (one line), so filling it moves
 *   nothing.
 * - A `[data-hunch-hide]` button records a `hide` signal for the slot's item: it is never
 *   recommended again, and items like it rank lower. The list then ranks again and focus moves
 *   to the link in the same slot. The button is shown (its `hidden` removed) only while the
 *   visitor consented, since the signal can't be stored otherwise; lay it out so showing it
 *   moves nothing. Don't put it inside a slot that is itself a link. A `[data-hunch-announce]`
 *   element in the list (a live region) gets its `data-message` when an item is hidden.
 *
 * Attributes: `manifest` (or `HunchConfig.manifest`), `sections` (comma-separated),
 * `exclude` (comma-separated item ids), `include-seen`, `diversity`, `because`, `because-min`. The slots,
 * states and events are the module's; hiding an item also fires `hunch:hide` (detail: `{ id }`).
 */
export class HunchForYouElement extends SlotsElement {
  private consented = false;
  /** Items whose hide is being recorded, and the number of hide clicks so far. */
  private hiding = new Set<string>();
  private clicks = 0;

  /** @internal Custom element lifecycle, called by the browser. */
  static get observedAttributes(): string[] {
    return [
      'manifest',
      'sections',
      'exclude',
      'include-seen',
      'diversity',
      'because',
      'because-min',
    ];
  }

  protected async recommend(
    hunch: Hunch,
    n: number,
    fallback: readonly string[],
  ): Promise<Recommendation[] | null> {
    this.consented = await hunch.consented();
    const recommendations = await hunch.recommend({
      n,
      sections: this.list('sections'),
      exclude: this.list('exclude'),
      includeSeen: this.hasAttribute('include-seen'),
      diversity: this.number('diversity'),
    });
    const personalized = recommendations.some((r) => r.why.confidence > 0);
    this.dataset.hunchPersonalized = String(personalized);
    if (personalized) return recommendations;
    // No profile yet, but an item the visitor hid must not stay in the fallback: show the
    // site's own order without it instead.
    const states = await Promise.all(fallback.map((id) => hunch.explain(id)));
    return states.some((state) => state?.hidden) ? recommendations : null;
  }

  protected decorate(slot: HTMLElement, rec: Recommendation | undefined): void {
    for (const button of slot.querySelectorAll<HTMLElement>('[data-hunch-hide]'))
      button.hidden = !this.consented || !slot.dataset.hunchId;
    const because = slot.querySelector('[data-hunch-because]');
    if (!because) return;
    // Only where the profile placed the item (most of its score is similarity), naming the item
    // it leans on most among those close to it: a distant one would be a guess.
    const why = rec?.why;
    const min = this.number('because-min') ?? 0.35;
    const source =
      why && why.confidence > 0 && why.similarityShare >= 0.5
        ? why.because.find((b) => b.similarity >= min)
        : undefined;
    because.textContent = source
      ? (this.getAttribute('because') ?? 'Because you read {title}').replace(
          '{title}',
          source.title,
        )
      : '';
  }

  protected onSlotClick(target: Element, slot: HTMLElement, index: number): boolean {
    const id = slot.dataset.hunchId;
    if (!target.closest('[data-hunch-hide]') || !id) return false;
    // A double click hides once; of quick clicks on several slots, the last one sets the focus.
    if (this.hiding.has(id)) return true;
    this.hiding.add(id);
    const click = ++this.clicks;
    void this.hunch()
      .then((hunch) => hunch.record('hide', id))
      .then((recorded) => {
        if (!recorded) return;
        if (click === this.clicks) this.focusAfter = index;
        this.refresh();
        const announce = this.querySelector<HTMLElement>('[data-hunch-announce]');
        if (announce) announce.textContent = announce.dataset.message ?? '';
        this.dispatchEvent(new CustomEvent('hunch:hide', { detail: { id } }));
      })
      .catch(() => {})
      .finally(() => this.hiding.delete(id));
    return true;
  }
}
