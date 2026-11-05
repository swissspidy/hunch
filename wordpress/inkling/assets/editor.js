/**
 * Block editor: once a published post is saved, embed it in this browser and store its vector.
 * If the editor leaves first, "Build index" under Settings → Inkling catches up.
 */
(function () {
  'use strict';
  const { select, dispatch, subscribe } = wp.data;
  const NOTICE = 'inkling-embed';
  let wasSaving = false;
  let running;
  let queued;

  function notice(status, message) {
    dispatch('core/notices').createNotice(status, message, {
      id: NOTICE,
      type: 'snackbar',
      isDismissible: true,
    });
  }

  async function embedCurrent(id) {
    try {
      const slow = setTimeout(
        () => notice('info', 'Inkling: embedding this post in your browser…'),
        1500,
      );
      const result = await window.inklingEmbed.embedPost(id).finally(() => clearTimeout(slow));
      if (result.stored) notice('success', 'Inkling: this post is in the index.');
    } catch (error) {
      console.error(error);
      notice(
        'warning',
        'Inkling could not embed this post here. "Build index" under Settings → Inkling will retry.',
      );
    }
  }

  /**
   * One embed at a time. A save that finishes during a run is queued and embedded after it
   * (embedPost() skips the post if its vector is already current).
   */
  function run(id) {
    if (running) {
      queued = id;
      return;
    }
    running = embedCurrent(id).finally(() => {
      running = undefined;
      const next = queued;
      queued = undefined;
      if (next !== undefined) run(next);
    });
  }

  subscribe(() => {
    const editor = select('core/editor');
    if (!editor) return;
    const saving = editor.isSavingPost() && !editor.isAutosavingPost();
    if (wasSaving && !saving && editor.didPostSaveRequestSucceed()) {
      const id = editor.getCurrentPostId();
      if (editor.getEditedPostAttribute('status') === 'publish') run(id);
    }
    wasSaving = saving;
  });
})();
