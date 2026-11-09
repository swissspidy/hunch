/**
 * The personalization controls block, as on the demo's home page: the visitor's consent switch
 * (when the site leaves consent to the visitor, or to the WP Consent API, whose "preferences"
 * category the switch then sets), pause or resume, export and forget. Withdrawing consent deletes
 * what was stored. Forget works even without an index (no manifest): it then
 * deletes the database directly.
 */
(function () {
  'use strict';
  const CONSENT_KEY = 'hunch-consent';
  const CATEGORY = 'preferences';
  const DATABASE = 'hunch';
  const roots = [...document.querySelectorAll('[data-hunch-controls]')];
  const updaters = [];

  /** Every controls block on the page shows the same state. */
  function syncAll() {
    for (const update of updaters) update().catch((error) => console.error(error));
  }

  function refreshLists() {
    for (const list of document.querySelectorAll('hunch-for-you')) list.refresh();
  }

  /** Deletes everything Hunch stored in this browser, with or without the catalog. */
  async function forget(manifest) {
    if (manifest && window.Hunch) {
      try {
        await (await window.Hunch.shared(manifest)).forget();
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

  /** With the WP Consent API, its functions are the consent manager's. */
  const consentApi = (root) =>
    root.dataset.consent === 'wp-consent-api' &&
    typeof window.wp_has_consent === 'function' &&
    typeof window.wp_set_consent === 'function';

  function storedConsent(root) {
    if (consentApi(root)) return window.wp_has_consent(CATEGORY);
    try {
      return localStorage.getItem(CONSENT_KEY) === 'yes';
    } catch {
      return false;
    }
  }

  function setup(root) {
    const manifest = root.dataset.manifest || '';
    const consent = root.querySelector('[data-hunch-consent]');
    const pause = root.querySelector('[data-hunch-pause]');
    const status = root.querySelector('[data-hunch-status]');
    const shared = () => window.Hunch.shared(manifest);
    const on = (el, listener) =>
      el?.addEventListener(el.type === 'checkbox' ? 'change' : 'click', () => {
        listener().catch((error) => {
          console.error(error);
          status.value = 'That did not work in this browser.';
        });
      });

    async function update() {
      if (consent) consent.checked = storedConsent(root);
      if (!manifest) {
        status.value = 'Personalization is off. Forget deletes anything stored earlier.';
        return;
      }
      const hunch = await shared();
      if (!(await hunch.consented())) {
        status.value =
          'Personalization is off: nothing new is recorded. Forget deletes anything stored earlier.';
        if (pause) pause.textContent = 'Pause';
        return;
      }
      const { signals } = await hunch.export();
      const paused = await hunch.paused();
      pause.textContent = paused ? 'Resume' : 'Pause';
      status.value = `${signals.length} ${signals.length === 1 ? 'item' : 'items'} remembered in this browser${paused ? ' (paused)' : ''}.`;
    }
    updaters.push(update);

    on(consent, async () => {
      if (consentApi(root)) {
        // The consent manager stores the choice and tells every listener, Hunch's included
        // (withdrawing deletes what was stored, see consent_cleanup()).
        window.wp_set_consent(CATEGORY, consent.checked ? 'allow' : 'deny');
        if (!consent.checked) await forget(manifest);
      } else if (consent.checked) {
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
      const hunch = await shared();
      if (await hunch.paused()) await hunch.resume();
      else await hunch.pause();
      syncAll();
    });
    on(root.querySelector('[data-hunch-forget]'), async () => {
      await forget(manifest);
      syncAll();
      refreshLists();
    });
    on(root.querySelector('[data-hunch-export]'), async () => {
      const data = await (await shared()).export();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      link.download = 'hunch-signals.json';
      link.click();
      URL.revokeObjectURL(link.href);
    });
    // The controls are disabled in the markup until they work.
    for (const control of root.querySelectorAll('input, button')) control.disabled = false;
  }

  roots.forEach(setup);
  syncAll();

  // Deleted elsewhere on the page (the WP Consent API's withdrawal, see consent_cleanup()).
  document.addEventListener('hunch:forgotten', () => {
    syncAll();
    refreshLists();
  });
  // Consent given or withdrawn in the consent manager's banner.
  document.addEventListener('wp_listen_for_consent_change', (event) => {
    if (event.detail?.[CATEGORY] === undefined) return;
    syncAll();
    refreshLists();
  });
})();
