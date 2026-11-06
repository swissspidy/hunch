/**
 * Settings → Inkling, "Build index": embeds every published post without a current vector, in
 * batches, in this browser, then writes the manifest and shards. Resumable: posts already
 * embedded are skipped, so a stopped or interrupted run continues where it left off.
 */
(function () {
  'use strict';
  const root = document.getElementById('inkling-index');
  if (!root) return;
  const build = root.querySelector('[data-inkling-build]');
  const stop = root.querySelector('[data-inkling-stop]');
  const progress = root.querySelector('[data-inkling-progress]');
  const status = root.querySelector('[data-inkling-status]');
  const total = Number(root.dataset.total) || 0;
  let stopping = false;

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
      status.value = 'Loading the model in this browser (the first time, 200 to 300 MB)…';
      await window.inklingEmbed.load();
      for (;;) {
        if (stopping) break;
        const batch = await wp.apiFetch({ path: `/inkling/v1/pending?after=${after}&limit=8` });
        for (const post of batch.posts) {
          if (stopping) break;
          status.value = `Embedding “${post.title}”…`;
          try {
            await window.inklingEmbed.store(post);
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
        status.value = 'Writing the index…';
        const state = await wp.apiFetch({ path: '/inkling/v1/regenerate', method: 'POST' });
        status.value =
          `${stopping ? 'Stopped. ' : ''}Embedded ${embedded} posts${failed ? `, ${failed} failed` : ''}. ` +
          `The index has ${state.count} posts${state.pending ? `, ${state.pending} still without a vector` : ''}.`;
      } else {
        status.value = 'Stopped.';
      }
      progress.value = stopping ? progress.value : 1;
    } catch (error) {
      console.error(error);
      status.value = `Inkling: ${error.message || 'the index could not be built'}.`;
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
