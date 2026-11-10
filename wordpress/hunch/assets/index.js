/**
 * Settings → Hunch, "Build index": embeds every published post without a current vector, in
 * batches, in this browser, then writes the manifest and shards. Resumable: posts already
 * embedded are skipped, so a stopped or interrupted run continues where it left off.
 */
(function () {
  'use strict';
  const root = document.getElementById('hunch-index');
  if (!root) return;
  const build = root.querySelector('[data-hunch-build]');
  const stop = root.querySelector('[data-hunch-stop]');
  const progress = root.querySelector('[data-hunch-progress]');
  const status = root.querySelector('[data-hunch-status]');
  const summary = root.querySelector('[data-hunch-summary]');
  const { __, _n, sprintf } = wp.i18n;
  let total = Number(root.dataset.total) || 0;
  let stopping = false;

  /** The counts above the button, and the last build's error, as they are now on the site. */
  async function refresh() {
    try {
      const now = await wp.apiFetch({ path: '/hunch/v1/status' });
      total = now.total;
      if (summary) summary.textContent = now.summary;
      const error = root.querySelector('[data-hunch-error]');
      if (error) error.hidden = !now.state.error;
    } catch (error) {
      console.error(error); // The line stays as the page rendered it.
    }
  }

  async function run() {
    stopping = false;
    build.disabled = true;
    stop.hidden = false;
    progress.hidden = false;
    progress.value = 0;
    let after = 0;
    let scanned = 0;
    let embedded = 0;
    let failed = 0;
    try {
      status.value = __(
        'Loading the model in this browser (the first time, 200 to 300 MB)…',
        'hunch',
      );
      await window.hunchEmbed.load();
      for (;;) {
        if (stopping) break;
        const batch = await wp.apiFetch({ path: `/hunch/v1/pending?after=${after}&limit=8` });
        for (const post of batch.posts) {
          if (stopping) break;
          /* translators: %s: post title */
          status.value = sprintf(__('Embedding “%s”…', 'hunch'), post.title);
          try {
            await window.hunchEmbed.store(post);
            embedded++;
          } catch (error) {
            // A post edited meanwhile (409) or a bad response: the next run tries again.
            console.error(error);
            failed++;
          }
          after = post.id;
        }
        scanned += batch.scanned;
        // Every pending post up to the cursor was handled (or the run stopped).
        if (!stopping) after = batch.cursor;
        progress.value = total ? Math.min(1, scanned / total) : 1;
        if (batch.done && !stopping) break;
      }
      if (embedded > 0 || !stopping) {
        status.value = __('Writing the index…', 'hunch');
        const state = await wp.apiFetch({ path: '/hunch/v1/regenerate', method: 'POST' });
        const parts = [
          /* translators: %d: number of posts */
          sprintf(_n('Embedded %d post.', 'Embedded %d posts.', embedded, 'hunch'), embedded),
          /* translators: %d: number of posts */
          sprintf(
            _n('The index has %d post.', 'The index has %d posts.', state.count, 'hunch'),
            state.count,
          ),
        ];
        if (stopping) parts.unshift(__('Stopped.', 'hunch'));
        if (failed) {
          parts.push(
            /* translators: %d: number of posts */
            sprintf(_n('%d post failed.', '%d posts failed.', failed, 'hunch'), failed),
          );
        }
        if (state.pending) {
          parts.push(
            sprintf(
              /* translators: %d: number of posts */
              _n(
                '%d post is still without a vector.',
                '%d posts are still without a vector.',
                state.pending,
                'hunch',
              ),
              state.pending,
            ),
          );
        }
        status.value = parts.join(' ');
        await refresh();
      } else {
        status.value = __('Stopped.', 'hunch');
      }
      progress.value = stopping ? progress.value : 1;
    } catch (error) {
      console.error(error);
      // The site's own messages are sentences already.
      status.value = error.message || __('The index could not be built.', 'hunch');
      // What the site has now: vectors stored before the failure, or its own error.
      await refresh();
    } finally {
      build.disabled = false;
      stop.hidden = true;
    }
  }

  build.addEventListener('click', () => {
    void run();
  });
  stop.addEventListener('click', () => {
    stopping = true;
  });
})();
