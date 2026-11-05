/**
 * A short digest of items with the browser's built-in Summarizer (the Summarizer API, which runs
 * an on-device model), where one is available. Elsewhere this returns `null` and the page keeps
 * whatever it shows instead. Nothing is sent anywhere: the model runs on the device too.
 */

interface SummarizerOptions {
  type: 'tldr' | 'key-points' | 'teaser' | 'headline';
  format: 'plain-text' | 'markdown';
  length: 'short' | 'medium' | 'long';
  sharedContext?: string;
}
interface Summarizer {
  summarize(text: string, options?: { context?: string }): Promise<string>;
  destroy?(): void;
}
interface SummarizerApi {
  availability(options: SummarizerOptions): Promise<string>;
  create(options: SummarizerOptions): Promise<Summarizer>;
}

/** An item to summarize: a `Recommendation`, or anything with a title. */
export interface DigestItem {
  /** The item's title. */
  title: string;
  /** The item's section, if any. */
  section?: string;
}

/** Options for {@link summarize} and {@link canSummarize}. */
export interface SummarizeOptions {
  /** Describes the site for the model (default: generic). */
  sharedContext?: string;
  /**
   * Also when the model still has to be downloaded (default false). A download needs a user
   * gesture in most browsers; without this, only a model already on the device is used.
   */
  allowDownload?: boolean;
}

const OPTIONS: SummarizerOptions = { type: 'tldr', format: 'plain-text', length: 'short' };

/** Whether `summarize()` can run now (or, with `allowDownload`, after a download). */
export async function canSummarize(options: SummarizeOptions = {}): Promise<boolean> {
  const api = (globalThis as { Summarizer?: SummarizerApi }).Summarizer;
  if (!api || typeof api.availability !== 'function') return false;
  try {
    const availability = await api.availability(OPTIONS);
    return (
      availability === 'available' ||
      (options.allowDownload === true &&
        (availability === 'downloadable' || availability === 'downloading'))
    );
  } catch {
    return false;
  }
}

/** One or two sentences about `items`, or `null` when no on-device model can write them. */
export async function summarize(
  items: readonly DigestItem[],
  options: SummarizeOptions = {},
): Promise<string | null> {
  if (items.length === 0 || !(await canSummarize(options))) return null;
  const api = (globalThis as { Summarizer?: SummarizerApi }).Summarizer!;
  let summarizer: Summarizer | undefined;
  try {
    summarizer = await api.create({
      ...OPTIONS,
      sharedContext:
        options.sharedContext ??
        "Headlines of articles a website published since the reader's last visit.",
    });
    const text = items
      .map((item) => (item.section ? `${item.title} (${item.section})` : item.title))
      .join('\n');
    const summary = (await summarizer.summarize(text)).trim();
    return summary || null;
  } catch {
    return null;
  } finally {
    summarizer?.destroy?.();
  }
}
