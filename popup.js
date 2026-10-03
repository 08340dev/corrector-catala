// © 2026 08340dev. Tots els drets reservats. Vegeu el fitxer LICENSE.
// Ventana del icono: activar/desactivar en general y para la web actual.

(async () => {
  const enabled = document.getElementById('enabled');
  const site = document.getElementById('site');
  const siteRow = document.getElementById('site-row');
  const hostLabel = document.getElementById('host');

  const settings = await chrome.storage.sync.get(CORRECTOR_DEFAULTS);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let host = '';
  try {
    const url = new URL(tab.url);
    if (url.protocol === 'http:' || url.protocol === 'https:') host = url.hostname;
  } catch (error) {
    host = '';
  }

  enabled.checked = settings.enabled;
  if (host) {
    hostLabel.textContent = host;
    site.checked = !settings.disabledHosts.includes(host);
  } else {
    siteRow.hidden = true;
  }

  enabled.addEventListener('change', () => {
    chrome.storage.sync.set({ enabled: enabled.checked });
  });

  site.addEventListener('change', async () => {
    const current = await chrome.storage.sync.get(CORRECTOR_DEFAULTS);
    const hosts = new Set(current.disabledHosts);
    if (site.checked) hosts.delete(host);
    else hosts.add(host);
    chrome.storage.sync.set({ disabledHosts: [...hosts] });
  });

  document.getElementById('options').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
