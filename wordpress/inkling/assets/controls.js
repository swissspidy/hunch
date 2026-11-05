/**
 * The personalization controls block, as on the demo's home page: the visitor's consent switch
 * (when the site leaves consent to the visitor), pause or resume, export and forget. Withdrawing
 * consent deletes what was stored.
 */
(function () {
  'use strict';
  const CONSENT_KEY = 'inkling-consent';

  function setup(root) {
    const manifest = root.dataset.manifest;
    const consent = root.querySelector('[data-inkling-consent]');
    const pause = root.querySelector('[data-inkling-pause]');
    const status = root.querySelector('[data-inkling-status]');
    const shared = () => window.Inkling.shared(manifest);
    const on = (el, listener) =>
      el?.addEventListener(el.type === 'checkbox' ? 'change' : 'click', () => {
        listener().catch((error) => console.error(error));
      });

    async function update() {
      const inkling = await shared();
      if (!(await inkling.consented())) {
        status.value = 'Personalization is off. Nothing is stored.';
        pause.textContent = 'Pause';
        return;
      }
      const { signals } = await inkling.export();
      const paused = await inkling.paused();
      pause.textContent = paused ? 'Resume' : 'Pause';
      status.value = `${signals.length} ${signals.length === 1 ? 'item' : 'items'} remembered in this browser${paused ? ' (paused)' : ''}.`;
    }

    function refresh() {
      for (const list of document.querySelectorAll('inkling-for-you')) list.refresh();
    }

    if (consent) {
      try {
        consent.checked = localStorage.getItem(CONSENT_KEY) === 'yes';
      } catch {
        consent.checked = false;
      }
      on(consent, async () => {
        if (consent.checked) {
          localStorage.setItem(CONSENT_KEY, 'yes');
        } else {
          localStorage.removeItem(CONSENT_KEY);
          await (await shared()).forget();
        }
        await update();
        refresh();
      });
    }
    on(pause, async () => {
      const inkling = await shared();
      if (await inkling.paused()) await inkling.resume();
      else await inkling.pause();
      await update();
    });
    on(root.querySelector('[data-inkling-forget]'), async () => {
      await (await shared()).forget();
      await update();
      refresh();
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
    update().catch((error) => console.error(error));
  }

  for (const root of document.querySelectorAll('[data-inkling-controls]')) setup(root);

  // WP Consent API: withdrawing the "preferences" category deletes what was stored.
  document.addEventListener('wp_listen_for_consent_change', (event) => {
    if (event.detail?.preferences !== 'deny') return;
    for (const root of document.querySelectorAll('[data-inkling-controls]')) {
      window.Inkling.shared(root.dataset.manifest).then((inkling) => inkling.forget());
    }
  });
})();
