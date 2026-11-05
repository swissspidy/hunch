/**
 * The personalization controls block, as on the demo's home page: the visitor's consent switch
 * (when the site leaves consent to the visitor), pause or resume, export and forget. Withdrawing
 * consent deletes what was stored. Forget works even without an index (no manifest): it then
 * deletes the database directly.
 */
(function () {
  'use strict';
  const CONSENT_KEY = 'inkling-consent';
  const DATABASE = 'inkling';
  const roots = [...document.querySelectorAll('[data-inkling-controls]')];
  const updaters = [];

  /** Every controls block on the page shows the same state. */
  function syncAll() {
    for (const update of updaters) update().catch((error) => console.error(error));
  }

  function refreshLists() {
    for (const list of document.querySelectorAll('inkling-for-you')) list.refresh();
  }

  /** Deletes everything Inkling stored in this browser, with or without the catalog. */
  async function forget(manifest) {
    if (manifest && window.Inkling) {
      try {
        await (await window.Inkling.shared(manifest)).forget();
        return;
      } catch (error) {
        console.error(error); // The manifest did not load: delete the database itself.
      }
    }
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DATABASE);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function storedConsent() {
    try {
      return localStorage.getItem(CONSENT_KEY) === 'yes';
    } catch {
      return false;
    }
  }

  function setup(root) {
    const manifest = root.dataset.manifest || '';
    const consent = root.querySelector('[data-inkling-consent]');
    const pause = root.querySelector('[data-inkling-pause]');
    const status = root.querySelector('[data-inkling-status]');
    const shared = () => window.Inkling.shared(manifest);
    const on = (el, listener) =>
      el?.addEventListener(el.type === 'checkbox' ? 'change' : 'click', () => {
        listener().catch((error) => {
          console.error(error);
          status.value = 'That did not work in this browser.';
        });
      });

    async function update() {
      if (consent) consent.checked = storedConsent();
      if (!manifest) {
        status.value = 'Personalization is off. Forget deletes anything stored earlier.';
        return;
      }
      const inkling = await shared();
      if (!(await inkling.consented())) {
        status.value =
          'Personalization is off: nothing new is recorded. Forget deletes anything stored earlier.';
        if (pause) pause.textContent = 'Pause';
        return;
      }
      const { signals } = await inkling.export();
      const paused = await inkling.paused();
      pause.textContent = paused ? 'Resume' : 'Pause';
      status.value = `${signals.length} ${signals.length === 1 ? 'item' : 'items'} remembered in this browser${paused ? ' (paused)' : ''}.`;
    }
    updaters.push(update);

    on(consent, async () => {
      if (consent.checked) {
        try {
          localStorage.setItem(CONSENT_KEY, 'yes');
        } catch {
          consent.checked = false;
          status.value =
            'This browser did not let the site save your choice, so personalization stays off.';
          return;
        }
      } else {
        try {
          localStorage.removeItem(CONSENT_KEY);
        } catch {
          // Nothing was stored, so there is nothing to remove.
        }
        await forget(manifest);
      }
      syncAll();
      refreshLists();
    });
    on(pause, async () => {
      const inkling = await shared();
      if (await inkling.paused()) await inkling.resume();
      else await inkling.pause();
      syncAll();
    });
    on(root.querySelector('[data-inkling-forget]'), async () => {
      await forget(manifest);
      syncAll();
      refreshLists();
    });
    on(root.querySelector('[data-inkling-export]'), async () => {
      const data = await (await shared()).export();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      link.download = 'inkling-signals.json';
      link.click();
      URL.revokeObjectURL(link.href);
    });
    // The controls are disabled in the markup until they work.
    for (const control of root.querySelectorAll('input, button')) control.disabled = false;
  }

  roots.forEach(setup);
  syncAll();

  // Deleted elsewhere on the page (the WP Consent API's withdrawal, see consent_cleanup()).
  document.addEventListener('inkling:forgotten', () => {
    syncAll();
    refreshLists();
  });
})();
