import type { Hunch, Recommendation } from '../client/index.ts';
import { summarize } from '../digest/summarize.ts';
import { SlotsElement } from './slots.ts';

/**
 * `<hunch-digest>`: what is new since the visitor's last visit, in server-rendered slots,
 * with an optional one-line summary by the browser's built-in Summarizer.
 *
 * The server renders a fallback (for example the latest items) and, optionally, an element with
 * `data-hunch-summary` holding placeholder text. On a returning visit (with consent), the
 * slots get the items published since the previous visit, ranked by the visitor's profile, and
 * the summary element gets the Summarizer's text where the browser has an on-device model.
 * Otherwise both stay as they are. Give the summary a fixed height, like the slots.
 *
 * ```html
 * <hunch-digest manifest="/hunch/manifest.json">
 *   <p data-hunch-summary>The latest articles.</p>
 *   <ol><li data-hunch-slot data-hunch-id="post-9">…</li></ol>
 * </hunch-digest>
 * ```
 *
 * Attributes: `manifest` (or `HunchConfig.manifest`), `sections`, `diversity`, `context`
 * (describes the site for the Summarizer). `data-hunch-new` is the number of new items shown, and
 * `data-hunch-summarized` whether a summary was written. Also fires `hunch:summary` (detail:
 * `{ summary }`).
 */
export class HunchDigestElement extends SlotsElement {
  /** The summary element's server-rendered text, put back on every refresh. */
  private placeholder: string | undefined;

  /** @internal Custom element lifecycle, called by the browser. */
  static get observedAttributes(): string[] {
    return ['manifest', 'sections', 'diversity'];
  }

  protected async recommend(
    hunch: Hunch,
    n: number,
    _fallback: readonly string[],
    run: number,
  ): Promise<Recommendation[] | null> {
    const recommendations = await hunch.sinceLastVisit({
      n,
      sections: this.list('sections'),
      diversity: this.number('diversity'),
    });
    // A newer refresh owns the element now.
    if (run !== this.run) return recommendations;
    this.dataset.hunchNew = String(recommendations.length);
    this.dataset.hunchSummarized = 'false';
    const target = this.querySelector<HTMLElement>('[data-hunch-summary]');
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
    const target = this.querySelector<HTMLElement>('[data-hunch-summary]');
    if (!target) return;
    const summary = await summarize(recommendations, {
      sharedContext: this.getAttribute('context') ?? undefined,
    });
    // Only the current refresh's summary: an older one would describe other items.
    if (run !== this.run || !summary || !this.isConnected) return;
    target.textContent = summary;
    this.dataset.hunchSummarized = 'true';
    this.dispatchEvent(new CustomEvent('hunch:summary', { detail: { summary } }));
  }
}
