/**
 * `<inkling-for-you>`: the visitor's recommendations in server-rendered slots.
 *
 * The server renders the site's own order (the cold start). Without consent or signals the
 * slots stay exactly as they are; with a profile, they are replaced by its recommendations.
 * `data-inkling-personalized` says which happened.
 *
 *   <inkling-for-you manifest="/inkling/manifest.json">
 *     <a data-inkling-slot data-inkling-id="post-1" href="/posts/1"><span data-inkling-title>…</span></a>
 *     …
 *   </inkling-for-you>
 *
 * Attributes: `manifest` (required), `sections` (comma-separated), `exclude` (comma-separated
 * item ids), `include-seen`, `diversity`. See `slots.ts` for the slots, states and events.
 */

import type { Inkling, Recommendation } from '../client/index.ts';
import { SlotsElement } from './slots.ts';

export class InklingForYouElement extends SlotsElement {
  static get observedAttributes(): string[] {
    return ['manifest', 'sections', 'exclude', 'include-seen', 'diversity'];
  }

  protected async recommend(inkling: Inkling, n: number): Promise<Recommendation[] | null> {
    const recommendations = await inkling.recommend({
      n,
      sections: this.list('sections'),
      exclude: this.list('exclude'),
      includeSeen: this.hasAttribute('include-seen'),
      diversity: this.number('diversity'),
    });
    const personalized = recommendations.some((r) => r.why.confidence > 0);
    this.dataset.inklingPersonalized = String(personalized);
    return personalized ? recommendations : null;
  }
}
