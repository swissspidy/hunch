/**
 * `<inkling-related>`: fills server-rendered slots with related items, in place.
 *
 * The server renders the element with a fixed number of slots holding a non-personalized
 * fallback (for example the latest items of the same section). Once the browser is idle, the
 * element asks the client for related items and replaces each slot with a copy of it whose
 * link, title, section, date and image are the related item's. The layout does not shift as
 * long as the slots' sizes do not depend on their text (clamp titles to a fixed number of
 * lines). Listeners attached to a slot do not carry over to its copy: delegate them to the
 * element instead.
 *
 *   <inkling-related manifest="/inkling/manifest.json" item="post-42" section="science">
 *     <a data-inkling-slot href="/posts/41"><span data-inkling-title>…</span></a>
 *     …
 *   </inkling-related>
 *
 * Attributes: `manifest` (required), `item` (required), `section` (the item's section: its
 * shard loads first), `sections` (`same`, or a comma-separated list), `diversity`.
 * State: `data-inkling-state` is `loading`, `ready` or `error`. Events: `inkling:ready`
 * (detail: `{ recommendations }`) and `inkling:error` (detail: `{ error }`).
 */

import { Inkling, type Recommendation } from '../client/index.ts';

const instances = new Map<string, Promise<Inkling>>();

/** One client per manifest URL, shared by every element on the page. */
export function inklingFor(manifest: string): Promise<Inkling> {
  const key = new URL(manifest, globalThis.location?.href).href;
  let instance = instances.get(key);
  if (!instance) {
    instance = Inkling.load({ manifest: key });
    instances.set(key, instance);
    instance.catch(() => instances.delete(key));
  }
  return instance;
}

// HTMLElement does not exist during server rendering; the class is then never defined.
const Base: typeof HTMLElement =
  typeof HTMLElement === 'undefined' ? (class {} as typeof HTMLElement) : HTMLElement;

export class InklingRelatedElement extends Base {
  private run = 0;

  connectedCallback(): void {
    this.schedule();
  }

  static get observedAttributes(): string[] {
    return ['item', 'manifest', 'sections', 'diversity'];
  }

  attributeChangedCallback(_name: string, old: string | null, value: string | null): void {
    if (old !== value && this.isConnected) this.schedule();
  }

  private schedule(): void {
    const run = ++this.run;
    this.dataset.inklingState = 'loading';
    whenIdle(() => {
      if (run === this.run) void this.update(run);
    });
  }

  private async update(run: number): Promise<void> {
    const manifest = this.getAttribute('manifest');
    const item = this.getAttribute('item');
    const slots = [...this.querySelectorAll<HTMLElement>('[data-inkling-slot]')];
    try {
      if (!manifest || !item) throw new Error('<inkling-related> needs manifest and item');
      if (slots.length === 0) throw new Error('<inkling-related> has no [data-inkling-slot]');
      const inkling = await inklingFor(manifest);
      const sections = this.getAttribute('sections');
      const diversity = this.getAttribute('diversity');
      const recommendations = await inkling.related(item, {
        n: slots.length,
        sectionHint: this.getAttribute('section') ?? undefined,
        sections:
          sections === 'same'
            ? 'same'
            : sections
              ? sections.split(',').map((s) => s.trim())
              : undefined,
        diversity: diversity ? Number(diversity) : undefined,
      });
      if (run !== this.run) return;
      // Each slot is swapped for a filled copy of itself: a new node of the same size, so no
      // existing node moves (which a layout shift would count, e.g. text after a changed title).
      recommendations.forEach((rec, i) => {
        const slot = slots[i]!;
        const copy = slot.cloneNode(true) as HTMLElement;
        fill(copy, rec);
        slot.replaceWith(copy);
      });
      this.dataset.inklingState = 'ready';
      this.dispatchEvent(new CustomEvent('inkling:ready', { detail: { recommendations } }));
    } catch (error) {
      if (run !== this.run) return;
      // The server-rendered fallback stays as it is.
      this.dataset.inklingState = 'error';
      this.dispatchEvent(new CustomEvent('inkling:error', { detail: { error } }));
    }
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
