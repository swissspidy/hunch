/**
 * The shared base of Hunch's list components: server-rendered slots, filled in idle time.
 *
 * The server renders a fixed number of slots (`[data-hunch-slot]`) holding a fallback. Once
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
 * State: `data-hunch-state` is `loading`, `ready` or `error`. Events: `hunch:ready` (detail:
 * `{ recommendations }`) and `hunch:error` (detail: `{ error }`). A click on a slot whose
 * `data-hunch-id` is set records a `click` signal (with consent) and fires `hunch:click`, which
 * bubbles (detail: `{ id, url, position, list, personalized }`: `position` counts from 1,
 * `list` is the element's name, `personalized` is true when "for you" used a profile). Hunch
 * sends neither event anywhere: listen to them to count impressions and clicks in your own
 * analytics, without any profile.
 */

import { Hunch, type Recommendation } from '../client/index.ts';
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
  /** The slot to focus after the next replacement (a button in it removed its item). */
  protected focusAfter: number | undefined;

  /**
   * Ranks `n` items, or returns `null` to show the server-rendered fallback (whose item ids
   * are `fallback`) as it is.
   */
  protected abstract recommend(
    hunch: Hunch,
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

  /** Adjusts a slot's copy after it was filled with `rec` (undefined: the fallback item). */
  protected decorate(_slot: HTMLElement, _rec: Recommendation | undefined): void {}

  /** A click inside a slot: a button the subclass handles, or a link (recorded as `click`). */
  protected onSlotClick(_target: Element, _slot: HTMLElement, _index: number): boolean {
    return false;
  }

  protected hunch(): Promise<Hunch> {
    const manifest = manifestOf(this);
    if (!manifest) return Promise.reject(new Error(`<${this.localName}> needs a manifest`));
    return Hunch.shared(manifest);
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
    this.dataset.hunchState = 'loading';
    whenIdle(() => {
      if (run === this.run) void this.update(run);
    });
  }

  private async update(run: number): Promise<void> {
    const slots = [...this.querySelectorAll<HTMLElement>('[data-hunch-slot]')];
    // Every refresh starts from the server's markup, not from an earlier ranking's.
    this.original ??= slots.map((slot) => slot.cloneNode(true) as HTMLElement);
    const original = this.original;
    // This run's focus request: dropped if the run fails, handed on if a newer run replaces it.
    const focus = this.focusAfter;
    this.focusAfter = undefined;
    const stale = (): boolean => {
      if (run === this.run) return false;
      this.focusAfter ??= focus;
      return true;
    };
    try {
      if (slots.length === 0) throw new Error(`<${this.localName}> has no [data-hunch-slot]`);
      const fallback = original.map((slot) => slot.dataset.hunchId ?? '').filter(Boolean);
      const recommendations = await this.recommend(await this.hunch(), slots.length, fallback, run);
      if (stale()) return;
      // Replacing the slot that holds focus would drop focus to the page: wait until it leaves,
      // unless the replacement moves focus itself.
      if (focus === undefined) await this.blurred();
      if (stale()) return;
      const copies = slots.map((slot, i) => {
        const copy = original[i]!.cloneNode(true) as HTMLElement;
        const rec = recommendations?.[i];
        if (rec) fill(copy, rec);
        // Fewer results than slots: an unfilled slot would show a stale or repeated item.
        else if (recommendations) copy.hidden = true;
        this.decorate(copy, rec);
        slot.replaceWith(copy);
        return copy;
      });
      if (focus !== undefined) {
        // The same slot's link, or the nearest shown one's.
        const order = copies
          .map((_, i) => i)
          .sort((a, b) => Math.abs(a - focus) - Math.abs(b - focus));
        const target = order.map((i) => copies[i]!).find((copy) => !copy.hidden);
        if (target) linkOf(target)?.focus();
      }
      this.dataset.hunchState = 'ready';
      this.dispatchEvent(
        new CustomEvent('hunch:ready', { detail: { recommendations: recommendations ?? [] } }),
      );
    } catch (error) {
      if (run !== this.run) return;
      // The server-rendered fallback stays as it is.
      this.dataset.hunchState = 'error';
      this.dispatchEvent(new CustomEvent('hunch:error', { detail: { error } }));
    }
  }

  /** Resolves once no slot holds focus: at once, unless one does. */
  private async blurred(): Promise<void> {
    while (this.slotHasFocus()) {
      // Focus leaves (focusout), or the focused slot is removed: Firefox fires no focusout then.
      await new Promise<void>((resolve) => {
        const observer = new MutationObserver(done);
        function done(): void {
          observer.disconnect();
          resolve();
        }
        this.addEventListener('focusout', done, { once: true });
        observer.observe(this, { childList: true, subtree: true });
      });
      // Focus may be moving to another slot: look again once it has landed.
      await new Promise((resolve) => setTimeout(resolve));
    }
  }

  private slotHasFocus(): boolean {
    // The focused element itself, also inside open shadow roots (activeElement is their host).
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    const slot = focused?.closest('[data-hunch-slot]');
    return !!slot && this.contains(slot);
  }

  private onClick(event: Event): void {
    const target = event.target as Element | null;
    const slot = target?.closest<HTMLElement>('[data-hunch-slot]');
    if (!slot || !target) return;
    const slots = [...this.querySelectorAll('[data-hunch-slot]')];
    if (this.onSlotClick(target, slot, slots.indexOf(slot))) {
      event.preventDefault();
      return;
    }
    const id = slot.dataset.hunchId;
    if (!id) return;
    // For the site's own analytics: which list, which item, at which position. Nothing is sent.
    this.dispatchEvent(
      new CustomEvent('hunch:click', {
        bubbles: true,
        detail: {
          id,
          url: (linkOf(slot) as HTMLAnchorElement | null)?.href ?? '',
          position: slots.indexOf(slot) + 1,
          list: this.localName,
          personalized: this.dataset.hunchPersonalized === 'true',
        },
      }),
    );
    // Best effort: the page may be gone before the write lands (its view is recorded next).
    void this.hunch().then(
      (hunch) => hunch.record('click', id),
      () => {},
    );
  }
}

function fill(slot: HTMLElement, rec: Recommendation): void {
  slot.dataset.hunchId = rec.id;
  // An aria-label that names the fallback item (`Read: <title>`) would give the link the wrong
  // name: it names the new item instead.
  const old = slot.querySelector('[data-hunch-title]')?.textContent?.trim();
  if (old) {
    for (const el of [slot, ...slot.querySelectorAll('[aria-label]')]) {
      const label = el.getAttribute('aria-label');
      // The title is the label's last occurrence of it: a prefix (`Article: Art`) may hold it too.
      const at = label?.lastIndexOf(old) ?? -1;
      if (label && at >= 0)
        el.setAttribute(
          'aria-label',
          label.slice(0, at) + rec.title + label.slice(at + old.length),
        );
    }
  }
  const link = linkOf(slot);
  if (link) {
    // Only web URLs: a javascript: URL from a catalog would run script when clicked.
    if (isWebUrl(rec.url)) link.setAttribute('href', rec.url);
    else link.removeAttribute('href');
  }
  setText(slot, '[data-hunch-title]', rec.title);
  setText(slot, '[data-hunch-section]', rec.section ?? '');
  const date = slot.querySelector('[data-hunch-date]');
  if (date) {
    date.textContent = rec.date ? formatDate(rec.date) : '';
    if (date.matches('time')) date.setAttribute('datetime', rec.date ?? '');
  }
  const image = slot.querySelector('img[data-hunch-image]');
  if (image) {
    if (rec.image && isWebUrl(rec.image)) image.setAttribute('src', rec.image);
    else image.removeAttribute('src');
    image.setAttribute('alt', '');
  }
}

/** A slot's link: the slot itself, else its `[data-hunch-href]`, else its first `a`. */
function linkOf(slot: HTMLElement): HTMLElement | null {
  return slot.matches('a')
    ? slot
    : (slot.querySelector<HTMLElement>('[data-hunch-href]') ?? slot.querySelector('a'));
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
