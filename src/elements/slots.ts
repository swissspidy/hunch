/**
 * The shared base of Inkling's list components: server-rendered slots, filled in idle time.
 *
 * The server renders a fixed number of slots (`[data-inkling-slot]`) holding a fallback. Once
 * the browser is idle, the element ranks items and replaces each slot with a copy of it whose
 * link, title, section, date and image are the ranked item's: new nodes of the same size, so no
 * existing node moves and the layout does not shift, as long as the slots' sizes do not depend
 * on their text (clamp titles to a fixed number of lines). Listeners attached to a slot do not
 * carry over to its copy: delegate them to the element.
 *
 * State: `data-inkling-state` is `loading`, `ready` or `error`. Events: `inkling:ready` (detail:
 * `{ recommendations }`) and `inkling:error` (detail: `{ error }`). A click on a slot whose
 * `data-inkling-id` is set records a `click` signal (with consent).
 */

import { Inkling, type Recommendation } from '../client/index.ts';

// HTMLElement does not exist during server rendering; the classes are then never defined.
export const Base: typeof HTMLElement =
  typeof HTMLElement === 'undefined' ? (class {} as typeof HTMLElement) : HTMLElement;

export abstract class SlotsElement extends Base {
  private run = 0;
  private listening = false;

  /** Ranks `n` items, or returns `null` to keep the fallback as it is. */
  protected abstract recommend(inkling: Inkling, n: number): Promise<Recommendation[] | null>;

  connectedCallback(): void {
    if (!this.listening) {
      this.listening = true;
      this.addEventListener('click', (event) => this.onClick(event));
    }
    this.schedule();
  }

  attributeChangedCallback(_name: string, old: string | null, value: string | null): void {
    if (old !== value && this.isConnected) this.schedule();
  }

  /** Ranks again (after a signal changed, for example). */
  refresh(): void {
    this.schedule();
  }

  protected inkling(): Promise<Inkling> {
    const manifest = this.getAttribute('manifest');
    if (!manifest) return Promise.reject(new Error(`<${this.localName}> needs a manifest`));
    return Inkling.shared(manifest);
  }

  protected list(name: string): string[] | undefined {
    const value = this.getAttribute(name);
    return value
      ? value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  }

  protected number(name: string): number | undefined {
    const value = this.getAttribute(name);
    return value === null || value === '' ? undefined : Number(value);
  }

  private schedule(): void {
    const run = ++this.run;
    this.dataset.inklingState = 'loading';
    whenIdle(() => {
      if (run === this.run) void this.update(run);
    });
  }

  private async update(run: number): Promise<void> {
    const slots = [...this.querySelectorAll<HTMLElement>('[data-inkling-slot]')];
    try {
      if (slots.length === 0) throw new Error(`<${this.localName}> has no [data-inkling-slot]`);
      const recommendations = await this.recommend(await this.inkling(), slots.length);
      if (run !== this.run) return;
      recommendations?.forEach((rec, i) => {
        const slot = slots[i]!;
        const copy = slot.cloneNode(true) as HTMLElement;
        fill(copy, rec);
        slot.replaceWith(copy);
      });
      this.dataset.inklingState = 'ready';
      this.dispatchEvent(
        new CustomEvent('inkling:ready', { detail: { recommendations: recommendations ?? [] } }),
      );
    } catch (error) {
      if (run !== this.run) return;
      // The server-rendered fallback stays as it is.
      this.dataset.inklingState = 'error';
      this.dispatchEvent(new CustomEvent('inkling:error', { detail: { error } }));
    }
  }

  private onClick(event: Event): void {
    const slot = (event.target as Element | null)?.closest<HTMLElement>('[data-inkling-slot]');
    const id = slot?.dataset.inklingId;
    // Best effort: the page may be gone before the write lands (its view is recorded next).
    if (id)
      void this.inkling().then(
        (inkling) => inkling.record('click', id),
        () => {},
      );
  }
}

function fill(slot: HTMLElement, rec: Recommendation): void {
  slot.dataset.inklingId = rec.id;
  const link = slot.matches('a') ? slot : slot.querySelector('[data-inkling-href], a');
  link?.setAttribute('href', rec.url);
  setText(slot, '[data-inkling-title]', rec.title);
  setText(slot, '[data-inkling-section]', rec.section ?? '');
  const date = slot.querySelector('[data-inkling-date]');
  if (date) {
    date.textContent = rec.date ? formatDate(rec.date) : '';
    if (date.matches('time')) date.setAttribute('datetime', rec.date ?? '');
  }
  const image = slot.querySelector('img[data-inkling-image]');
  if (image && rec.image) {
    image.setAttribute('src', rec.image);
    image.setAttribute('alt', '');
  }
}

function setText(slot: HTMLElement, selector: string, text: string): void {
  const el = slot.querySelector(selector);
  if (el) el.textContent = text;
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
    dateStyle: 'medium',
  }).format(t);
}

function whenIdle(callback: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(callback, { timeout: 2000 });
  else setTimeout(callback, 1);
}
