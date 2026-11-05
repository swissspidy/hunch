/**
 * `<inkling-for-you>`: the visitor's recommendations in server-rendered slots.
 *
 * The server renders the site's own order (the cold start). Without consent or signals the
 * slots stay exactly as they are; with a profile, they are replaced by its recommendations.
 * If the visitor hid an item the fallback shows, the catalog's own order without it is shown.
 * `data-inkling-personalized` says which happened.
 *
 *   <inkling-for-you manifest="/inkling/manifest.json">
 *     <a data-inkling-slot data-inkling-id="post-1" href="/posts/1"><span data-inkling-title>…</span></a>
 *     …
 *   </inkling-for-you>
 *
 * Attributes: `manifest` (or `InklingConfig.manifest`), `sections` (comma-separated),
 * `exclude` (comma-separated item ids), `include-seen`, `diversity`. See `slots.ts` for the slots, states and events.
 */

import type { Inkling, Recommendation } from '../client/index.ts';
import { SlotsElement } from './slots.ts';

export class InklingForYouElement extends SlotsElement {
  static get observedAttributes(): string[] {
    return ['manifest', 'sections', 'exclude', 'include-seen', 'diversity'];
  }

  protected async recommend(
    inkling: Inkling,
    n: number,
    fallback: readonly string[],
  ): Promise<Recommendation[] | null> {
    const recommendations = await inkling.recommend({
      n,
      sections: this.list('sections'),
      exclude: this.list('exclude'),
      includeSeen: this.hasAttribute('include-seen'),
      diversity: this.number('diversity'),
    });
    const personalized = recommendations.some((r) => r.why.confidence > 0);
    this.dataset.inklingPersonalized = String(personalized);
    if (personalized) return recommendations;
    // No profile yet, but an item the visitor hid must not stay in the fallback: show the
    // site's own order without it instead.
    const states = await Promise.all(fallback.map((id) => inkling.explain(id)));
    return states.some((state) => state?.hidden) ? recommendations : null;
  }
}
