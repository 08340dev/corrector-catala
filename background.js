// © 2026 08340dev. Tots els drets reservats. Vegeu el fitxer LICENSE.
// Service worker: es la única parte que habla con el servidor LanguageTool.
// Hacer aquí la petición (y no en el content script) evita los bloqueos CORS
// de las páginas donde el usuario escribe.

importScripts('defaults.js');

const TIMEOUT_MS = 15000;
// Si el servidor detecta con esta confianza que el texto NO es catalán,
// no mostramos correcciones (evita subrayar un correo escrito en castellano).
const OTHER_LANGUAGE_CONFIDENCE = 0.9;
const OTHER_LANGUAGE_MIN_CHARS = 40;

function simplify(match) {
  const rule = match.rule || {};
  return {
    offset: match.offset,
    length: match.length,
    message: match.message || '',
    shortMessage: match.shortMessage || '',
    replacements: (match.replacements || []).slice(0, 5).map((r) => r.value),
    ruleId: rule.id || '',
    issueType: rule.issueType || '',
    category: (rule.category && rule.category.name) || ''
  };
}

async function checkText(text) {
  const { serverUrl, language } = await chrome.storage.sync.get(CORRECTOR_DEFAULTS);
  const url = serverUrl.replace(/\/+$/, '') + '/check';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text, language }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const data = await response.json();
    const detected = data.language && data.language.detectedLanguage;
    const otherLanguage = Boolean(
      detected &&
        text.length >= OTHER_LANGUAGE_MIN_CHARS &&
        !String(detected.code || '').startsWith('ca') &&
        detected.confidence >= OTHER_LANGUAGE_CONFIDENCE
    );

    return { ok: true, otherLanguage, matches: (data.matches || []).map(simplify) };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'check' && typeof message.text === 'string') {
    checkText(message.text).then(sendResponse);
    return true; // respuesta asíncrona
  }
  return false;
});
