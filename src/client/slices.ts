/**
 * Long work in slices, so a large catalog does not block input (ADR 0008). Ranking and shard
 * decoding yield to the page between slices; where the slices fall never changes a result.
 */

/** A ranking yields to the page once it has run this long… */
const SLICE_MS = 10;
/** …checked every this many candidates. */
export const SLICE_ITEMS = 512;

/**
 * Lets the page handle input and render: through `scheduler.yield()` where there is one (the
 * work resumes ahead of other tasks), otherwise through a new task.
 */
export function yieldToPage(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve));
}

/** Yields to the page if a slice is over, and otherwise returns nothing to wait for. */
export type Pause = () => Promise<void> | undefined;

/**
 * A pause for one ranking: it yields once `SLICE_MS` have passed since the ranking started or
 * last yielded. A ranking that takes less never yields.
 */
export function slicer(): Pause {
  let start = performance.now();
  return () =>
    performance.now() - start < SLICE_MS
      ? undefined
      : yieldToPage().then(() => {
          start = performance.now();
        });
}
