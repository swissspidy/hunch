/**
 * `<inkling-digest>`: what is new since the visitor's last visit, in server-rendered slots,
 * with an optional one-line summary by the browser's built-in Summarizer.
 *
 * The server renders a fallback (for example the latest items) and, optionally, an element with
 * `data-inkling-summary` holding placeholder text. On a returning visit (with consent), the
 * slots get the items published since the previous visit, ranked by the visitor's profile, and
 * the summary element gets the Summarizer's text where the browser has an on-device model.
 * Otherwise both stay as they are. Give the summary a fixed height, like the slots.
 *
 *   <inkling-digest manifest="/inkling/manifest.json">
 *     <p data-inkling-summary>The latest articles.</p>
 *     <ol><li data-inkling-slot data-inkling-id="post-9">…</li></ol>
 *   </inkling-digest>
 *
 * Attributes: `manifest` (required), `sections`, `diversity`, `context` (describes the site for
 * the Summarizer). `data-inkling-new` is the number of new items shown, and
 * `data-inkling-summarized` whether a summary was written. Also fires `inkling:summary` (detail:
 * `{ summary }`).
 */

import type { Inkling, Recommendation } from '../client/index.ts';
import { summarize } from '../digest/summarize.ts';
import { SlotsElement } from './slots.ts';

export class InklingDigestElement extends SlotsElement {
  static get observedAttributes(): string[] {
    return ['manifest', 'sections', 'diversity'];
  }

  protected async recommend(inkling: Inkling, n: number): Promise<Recommendation[] | null> {
    const recommendations = await inkling.sinceLastVisit({
      n,
      sections: this.list('sections'),
      diversity: this.number('diversity'),
    });
    this.dataset.inklingNew = String(recommendations.length);
    this.dataset.inklingSummarized = 'false';
    if (recommendations.length === 0) return null;
    void this.summarize(recommendations);
    return recommendations;
  }

  private async summarize(recommendations: Recommendation[]): Promise<void> {
    const target = this.querySelector<HTMLElement>('[data-inkling-summary]');
    if (!target) return;
    const summary = await summarize(recommendations, {
      sharedContext: this.getAttribute('context') ?? undefined,
    });
    if (!summary || !this.isConnected) return;
    target.textContent = summary;
    this.dataset.inklingSummarized = 'true';
    this.dispatchEvent(new CustomEvent('inkling:summary', { detail: { summary } }));
  }
}
