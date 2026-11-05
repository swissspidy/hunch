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
 * Attributes: `manifest` (or `InklingConfig.manifest`), `sections`, `diversity`, `context`
 * (describes the site for the Summarizer). `data-inkling-new` is the number of new items shown, and
 * `data-inkling-summarized` whether a summary was written. Also fires `inkling:summary` (detail:
 * `{ summary }`).
 */

import type { Inkling, Recommendation } from '../client/index.ts';
import { summarize } from '../digest/summarize.ts';
import { SlotsElement } from './slots.ts';

export class InklingDigestElement extends SlotsElement {
  /** The summary element's server-rendered text, put back on every refresh. */
  private placeholder: string | undefined;

  static get observedAttributes(): string[] {
    return ['manifest', 'sections', 'diversity'];
  }

  protected async recommend(
    inkling: Inkling,
    n: number,
    _fallback: readonly string[],
    run: number,
  ): Promise<Recommendation[] | null> {
    const recommendations = await inkling.sinceLastVisit({
      n,
      sections: this.list('sections'),
      diversity: this.number('diversity'),
    });
    // A newer refresh owns the element now.
    if (run !== this.run) return recommendations;
    this.dataset.inklingNew = String(recommendations.length);
    this.dataset.inklingSummarized = 'false';
    const target = this.querySelector<HTMLElement>('[data-inkling-summary]');
    if (target) {
      // An earlier summary describes earlier items: start from the server's text again.
      this.placeholder ??= target.textContent;
      target.textContent = this.placeholder;
    }
    if (recommendations.length === 0) return null;
    void this.summarize(recommendations, run);
    return recommendations;
  }

  private async summarize(recommendations: Recommendation[], run: number): Promise<void> {
    const target = this.querySelector<HTMLElement>('[data-inkling-summary]');
    if (!target) return;
    const summary = await summarize(recommendations, {
      sharedContext: this.getAttribute('context') ?? undefined,
    });
    // Only the current refresh's summary: an older one would describe other items.
    if (run !== this.run || !summary || !this.isConnected) return;
    target.textContent = summary;
    this.dataset.inklingSummarized = 'true';
    this.dispatchEvent(new CustomEvent('inkling:summary', { detail: { summary } }));
  }
}
