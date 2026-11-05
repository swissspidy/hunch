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
 * Focus is never moved or lost: while a slot holds focus, the element waits for it to leave
 * before replacing the slots (it stays `loading` until then). The slots' accessible names follow
 * their content; an `aria-label` that contains the fallback item's title gets the new title.
 *
 * Each refresh starts again from the server-rendered slots. When there are fewer results than
 * slots, the remaining slots are hidden rather than left showing a fallback item.
 *
 * State: `data-inkling-state` is `loading`, `ready` or `error`. Events: `inkling:ready` (detail:
 * `{ recommendations }`) and `inkling:error` (detail: `{ error }`). A click on a slot whose
 * `data-inkling-id` is set records a `click` signal (with consent).
 */

import { Inkling, type Recommendation } from '../client/index.ts';
import { manifestOf } from './config.ts';

// HTMLElement does not exist during server rendering; the classes are then never defined.
export const Base: typeof HTMLElement =
  typeof HTMLElement === 'undefined' ? (class {} as typeof HTMLElement) : HTMLElement;

export abstract class SlotsElement extends Base {
  /** The render generation: each refresh increments it, and stale work checks it. */
  protected run = 0;
  private listening = false;
  /** Copies of the server-rendered slots, taken before the first replacement. */
  private original: HTMLElement[] | undefined;

  /**
   * Ranks `n` items, or returns `null` to show the server-rendered fallback (whose item ids
   * are `fallback`) as it is.
   */
  protected abstract recommend(
    inkling: Inkling,
    n: number,
    fallback: readonly string[],
    run: number,
  ): Promise<Recommendation[] | null>;

  /** @internal Custom element lifecycle, called by the browser. */
  connectedCallback(): void {
    if (!this.listening) {
      this.listening = true;
      this.addEventListener('click', (event) => this.onClick(event));
    }
    this.schedule();
  }

  /** @internal Custom element lifecycle, called by the browser. */
  attributeChangedCallback(_name: string, old: string | null, value: string | null): void {
    if (old !== value && this.isConnected) this.schedule();
  }

  /** Ranks again (after a signal changed, for example). */
  refresh(): void {
    this.schedule();
  }

  protected inkling(): Promise<Inkling> {
    const manifest = manifestOf(this);
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
    // Every refresh starts from the server's markup, not from an earlier ranking's.
    this.original ??= slots.map((slot) => slot.cloneNode(true) as HTMLElement);
    const original = this.original;
    try {
      if (slots.length === 0) throw new Error(`<${this.localName}> has no [data-inkling-slot]`);
      const fallback = original.map((slot) => slot.dataset.inklingId ?? '').filter(Boolean);
      const recommendations = await this.recommend(
        await this.inkling(),
        slots.length,
        fallback,
        run,
      );
      if (run !== this.run) return;
      // Replacing the slot that holds focus would drop focus to the page: wait until it leaves.
      await this.blurred();
      if (run !== this.run) return;
      slots.forEach((slot, i) => {
        const copy = original[i]!.cloneNode(true) as HTMLElement;
        if (recommendations) {
          const rec = recommendations[i];
          if (rec) fill(copy, rec);
          // Fewer results than slots: an unfilled slot would show a stale or repeated item.
          else copy.hidden = true;
        }
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

  /** Resolves once focus is outside the element: at once, unless a slot holds it. */
  private async blurred(): Promise<void> {
    while (this.contains(document.activeElement)) {
      await new Promise((resolve) => this.addEventListener('focusout', resolve, { once: true }));
      // Focus may be moving to another slot: look again once it has landed.
      await new Promise((resolve) => setTimeout(resolve));
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
  // An aria-label that names the fallback item (`Read: <title>`) would give the link the wrong
  // name: it names the new item instead.
  const old = slot.querySelector('[data-inkling-title]')?.textContent?.trim();
  if (old) {
    for (const el of [slot, ...slot.querySelectorAll('[aria-label]')]) {
      const label = el.getAttribute('aria-label');
      if (label?.includes(old))
        el.setAttribute(
          'aria-label',
          label.replace(old, () => rec.title),
        );
    }
  }
  const link = slot.matches('a') ? slot : slot.querySelector('[data-inkling-href], a');
  if (link) {
    // Only web URLs: a javascript: URL from a catalog would run script when clicked.
    if (isWebUrl(rec.url)) link.setAttribute('href', rec.url);
    else link.removeAttribute('href');
  }
  setText(slot, '[data-inkling-title]', rec.title);
  setText(slot, '[data-inkling-section]', rec.section ?? '');
  const date = slot.querySelector('[data-inkling-date]');
  if (date) {
    date.textContent = rec.date ? formatDate(rec.date) : '';
    if (date.matches('time')) date.setAttribute('datetime', rec.date ?? '');
  }
  const image = slot.querySelector('img[data-inkling-image]');
  if (image) {
    if (rec.image && isWebUrl(rec.image)) image.setAttribute('src', rec.image);
    else image.removeAttribute('src');
    image.setAttribute('alt', '');
  }
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url, document.baseURI);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
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
