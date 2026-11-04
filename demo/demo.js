// The demo's controls: consent, pause, forget and export on the home page; "More like this"
// and "Not interested" on articles; and the "Why these?" lists. Plain script, no build.
const manifest = document.body.dataset.manifest;
const CONSENT_KEY = 'inkling-demo-consent';
const $ = (id) => document.getElementById(id);
/** An async event listener whose failures are logged. */
const on = (el, type, listener) =>
  el.addEventListener(type, (event) => {
    listener(event).catch((error) => console.error(error));
  });

function hasConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) === 'yes';
  } catch {
    return false;
  }
}

async function updateStatus() {
  const status = $('status');
  if (!status) return;
  const inkling = await Inkling.shared(manifest);
  if (!hasConsent()) {
    status.value = 'Personalization is off. Nothing is stored.';
  } else {
    const { signals } = await inkling.export();
    const paused = await inkling.paused();
    $('pause').textContent = paused ? 'Resume' : 'Pause';
    status.value = `${signals.length} ${signals.length === 1 ? 'signal' : 'signals'} stored in this browser${paused ? ' (paused)' : ''}.`;
  }
}

function refreshForYou() {
  document.querySelector('inkling-for-you')?.refresh();
}

const consent = $('consent');
if (consent) {
  consent.checked = hasConsent();
  on(consent, 'change', async () => {
    const inkling = await Inkling.shared(manifest);
    if (consent.checked) {
      localStorage.setItem(CONSENT_KEY, 'yes');
    } else {
      // Withdrawing consent deletes what was stored.
      localStorage.removeItem(CONSENT_KEY);
      await inkling.forget();
    }
    await updateStatus();
    refreshForYou();
  });
  on($('pause'), 'click', async () => {
    const inkling = await Inkling.shared(manifest);
    if (await inkling.paused()) await inkling.resume();
    else await inkling.pause();
    await updateStatus();
  });
  on($('forget'), 'click', async () => {
    await (await Inkling.shared(manifest)).forget();
    await updateStatus();
    refreshForYou();
  });
  on($('export'), 'click', async () => {
    const data = await (await Inkling.shared(manifest)).export();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    link.download = 'inkling-signals.json';
    link.click();
    URL.revokeObjectURL(link.href);
  });
  void updateStatus();
}

// Explicit signals on article pages.
for (const button of document.querySelectorAll('[data-signal]')) {
  on(button, 'click', async () => {
    const id = button.closest('[data-item]').dataset.item;
    const inkling = await Inkling.shared(manifest);
    const recorded = await inkling.record(button.dataset.signal, id);
    $('feedback').value = !recorded
      ? 'Turn on personalization on the home page first.'
      : button.dataset.signal === 'follow'
        ? 'Noted: more like this.'
        : 'Noted: you will not see this again.';
  });
}

// "Why these?": the ranking's terms for each item.
const percent = (x) => `${Math.round(x * 100)}%`;
for (const list of document.querySelectorAll('inkling-related, inkling-for-you')) {
  list.addEventListener('inkling:ready', ({ detail }) => {
    const why = $('why-list');
    if (detail.recommendations.length === 0) {
      // A refresh without results (after forget, or consent withdrawn): no stale reasons. On
      // the first ranking, the placeholder stays.
      if (list.dataset.inklingRanked) why.replaceChildren();
      return;
    }
    list.dataset.inklingRanked = 'true';
    why.replaceChildren(
      ...detail.recommendations.map((r) => {
        const li = document.createElement('li');
        const { why } = r;
        li.textContent =
          why.confidence === 1
            ? `${r.title}: similarity ${why.similarity.toFixed(2)}, recency ${why.recency.toFixed(2)}`
            : why.similarityShare < 0.5 || why.because.length === 0
              ? `${r.title}: an editors' pick (${percent(1 - why.similarityShare)} of its score)`
              : `${r.title}: because you read ${why.because.map((b) => `“${b.title}” (${percent(b.share)})`).join(', ')}`;
        return li;
      }),
    );
  });
}
