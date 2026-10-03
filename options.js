// © 2026 08340dev. Tots els drets reservats. Vegeu el fitxer LICENSE.
// Página de opciones.

const $ = (id) => document.getElementById(id);
const lines = (value) => [...new Set(value.split('\n').map((s) => s.trim()).filter(Boolean))];

async function load() {
  const settings = await chrome.storage.sync.get(CORRECTOR_DEFAULTS);
  $('language').value = settings.language;
  $('serverUrl').value = settings.serverUrl;
  $('dictionary').value = settings.dictionary.join('\n');
  $('disabledHosts').value = settings.disabledHosts.join('\n');
}

function say(text) {
  $('status').textContent = text;
  if (text) setTimeout(() => ($('status').textContent = ''), 4000);
}

async function save() {
  const serverUrl = ($('serverUrl').value.trim() || CORRECTOR_DEFAULTS.serverUrl).replace(/\/+$/, '');

  let origin;
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    origin = url.origin + '/*';
  } catch (error) {
    say("L'adreça del servidor no és vàlida.");
    return;
  }

  // Un servidor nuevo necesita permiso explícito del usuario.
  const granted = await chrome.permissions.contains({ origins: [origin] });
  if (!granted) {
    const accepted = await chrome.permissions.request({ origins: [origin] });
    if (!accepted) {
      say('Cal el permís per a connectar amb aquest servidor.');
      return;
    }
  }

  await chrome.storage.sync.set({
    language: $('language').value,
    serverUrl,
    dictionary: lines($('dictionary').value),
    disabledHosts: lines($('disabledHosts').value)
  });
  $('serverUrl').value = serverUrl;
  say('Canvis desats');
}

$('save').addEventListener('click', save);
$('reset').addEventListener('click', () => {
  $('serverUrl').value = CORRECTOR_DEFAULTS.serverUrl;
});

load();
