// © 2026 08340dev. Tots els drets reservats. Vegeu el fitxer LICENSE.
// Content script: vigila los campos donde escribe el usuario, pide la
// corrección al service worker y pinta los subrayados y las sugerencias.
//
//  - <textarea>          -> capa "espejo" superpuesta con los subrayados.
//  - contenteditable     -> CSS Custom Highlight API (no modifica el HTML).

(() => {
  'use strict';

  if (window.__correctorCatalaLoaded) return;
  window.__correctorCatalaLoaded = true;

  const DEBOUNCE_MS = 500; // pausa tras la última tecla antes de corregir
  const MAX_BATCH_CHARS = 15000; // tamaño máximo de cada petición
  const CACHE_LIMIT = 500; // párrafos recordados por página
  const RETRY_AFTER_ERROR_MS = 10000;
  const CODE_EDITORS = '.CodeMirror, .cm-editor, .monaco-editor, .ace_editor';
  const KIND_LABEL = { spell: 'Ortografia', grammar: 'Gramàtica', style: 'Estil' };
  const BLOCK_TAGS = /^(P|DIV|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TR|TABLE|SECTION|ARTICLE)$/;
  const COPIED_STYLES = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
    'fontKerning', 'fontFeatureSettings', 'lineHeight', 'letterSpacing', 'wordSpacing',
    'textTransform', 'textIndent', 'textAlign', 'tabSize', 'direction', 'whiteSpace',
    'overflowWrap', 'wordBreak', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'
  ];

  let settings = { ...CORRECTOR_DEFAULTS };
  let alive = true; // pasa a false si la extensión se recarga o desinstala
  let pausedUntil = 0;
  let ui = null;
  let ticker = 0;
  let layoutQueued = false;

  const cache = new Map(); // texto de párrafo -> errores
  const ignored = new Set(); // "regla|texto" ignorados en esta página
  const fields = new Map(); // elemento -> campo vigilado

  // Registros de subrayado para contenteditable (Chrome 105+).
  const highlights =
    typeof Highlight === 'function' && window.CSS && CSS.highlights
      ? { spell: new Highlight(), grammar: new Highlight(), style: new Highlight() }
      : null;
  if (highlights) {
    for (const kind of Object.keys(highlights)) {
      CSS.highlights.set('corrector-catala-' + kind, highlights[kind]);
    }
  }

  // ---------------------------------------------------------------- utilidades

  function kindOf(match) {
    if (match.issueType === 'misspelling') return 'spell';
    if (['style', 'typographical', 'register', 'whitespace'].includes(match.issueType)) return 'style';
    return 'grammar';
  }

  function isActive() {
    return alive && settings.enabled && !settings.disabledHosts.includes(location.hostname);
  }

  function isLetter(char) {
    return Boolean(char) && /\p{L}/u.test(char);
  }

  // Mientras llega la nueva corrección, recoloca los errores ya conocidos
  // según lo que se ha tecleado, para que los subrayados no se descuadren.
  function shiftMatches(before, after, matches) {
    if (before === after) return matches;
    const max = Math.min(before.length, after.length);
    let prefix = 0;
    while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
    let suffix = 0;
    while (
      suffix < max - prefix &&
      before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
    ) {
      suffix++;
    }
    const oldEnd = before.length - suffix;
    const delta = after.length - before.length;
    const out = [];
    for (const m of matches) {
      const end = m.offset + m.length;
      if (end < prefix || (end === prefix && !isLetter(after[prefix]))) {
        out.push(m);
      } else if (
        m.offset > oldEnd ||
        (m.offset === oldEnd && !isLetter(after[m.offset + delta - 1]))
      ) {
        out.push({ ...m, offset: m.offset + delta });
      }
    }
    return out;
  }

  function remember(text, matches) {
    cache.set(text, matches);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  function askServer(text) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'check', text }, (response) => {
          if (chrome.runtime.lastError || !response) resolve({ ok: false });
          else resolve(response);
        });
      } catch (error) {
        alive = false; // contexto de la extensión invalidado
        resolve({ ok: false });
      }
    });
  }

  // Corrige por párrafos: solo se envían al servidor los que han cambiado.
  async function computeMatches(text) {
    const paragraphs = [];
    let position = 0;
    for (const line of text.split('\n')) {
      paragraphs.push({ text: line, start: position });
      position += line.length + 1;
    }

    const pending = new Map();
    for (const p of paragraphs) {
      const worthChecking = p.text.trim().length >= 3 && p.text.length <= MAX_BATCH_CHARS;
      if (worthChecking && !cache.has(p.text)) pending.set(p.text, p);
    }
    const queue = [...pending.values()];

    let i = 0;
    while (i < queue.length) {
      const batch = [];
      let size = 0;
      while (i < queue.length && (batch.length === 0 || size + queue[i].text.length + 2 <= MAX_BATCH_CHARS)) {
        batch.push(queue[i]);
        size += queue[i].text.length + 2;
        i++;
      }
      const response = await askServer(batch.map((p) => p.text).join('\n\n'));
      if (!response.ok) {
        pausedUntil = Date.now() + RETRY_AFTER_ERROR_MS;
        return null;
      }
      let base = 0;
      for (const p of batch) {
        const end = base + p.text.length;
        const own = response.otherLanguage
          ? []
          : response.matches
              .filter((m) => m.offset >= base && m.offset + m.length <= end)
              .map((m) => ({ ...m, offset: m.offset - base }));
        remember(p.text, own);
        base = end + 2;
      }
    }

    const all = [];
    for (const p of paragraphs) {
      const own = cache.get(p.text);
      if (own) for (const m of own) all.push({ ...m, offset: m.offset + p.start });
    }
    return all;
  }

  // Quita solapamientos, errores ignorados y palabras del diccionario personal.
  function filterMatches(text, matches) {
    const dictionary = new Set(settings.dictionary.map((w) => w.toLowerCase()));
    const out = [];
    let lastEnd = -1;
    for (const m of [...matches].sort((a, b) => a.offset - b.offset)) {
      if (m.offset < lastEnd || m.length <= 0) continue;
      const word = text.substr(m.offset, m.length);
      if (ignored.has(m.ruleId + '|' + word)) continue;
      if (kindOf(m) === 'spell' && dictionary.has(word.toLowerCase())) continue;
      out.push(m);
      lastEnd = m.offset + m.length;
    }
    return out;
  }

  // ------------------------------------------------------ interfaz (Shadow DOM)

  const UI_CSS = `
    :host { all: initial; }
    .mirror { position: absolute; overflow: hidden; pointer-events: none; }
    .mirror-inner {
      position: absolute; top: 0; left: 0; box-sizing: border-box; margin: 0; border: 0;
      color: transparent; pointer-events: none;
    }
    .mirror-inner span {
      text-decoration: underline wavy; text-decoration-thickness: 1.5px;
      text-underline-offset: 2px; text-decoration-skip-ink: none;
    }
    .mirror-inner .spell { text-decoration-color: #d93025; }
    .mirror-inner .grammar { text-decoration-color: #e8870c; }
    .mirror-inner .style { text-decoration-color: #1a73e8; }

    .popup {
      position: absolute; pointer-events: auto; box-sizing: border-box;
      width: max-content; min-width: 200px; max-width: 320px; padding: 12px;
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #1f1f1f; background: #fff; border: 1px solid rgba(0, 0, 0, 0.14);
      border-radius: 10px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
    }
    .popup[hidden] { display: none; }
    .head { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600;
      text-transform: none; color: #5f6368; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .dot.spell { background: #d93025; } .dot.grammar { background: #e8870c; } .dot.style { background: #1a73e8; }
    .message { margin: 6px 0 10px; }
    .suggestions { display: flex; flex-wrap: wrap; gap: 6px; }
    button { font: inherit; cursor: pointer; border-radius: 6px; }
    .suggestion { padding: 5px 10px; color: #fff; background: #1a73e8; border: 1px solid #1a73e8; font-weight: 600; }
    .suggestion:hover { background: #1558b0; border-color: #1558b0; }
    .actions { display: flex; gap: 4px; margin: 10px -6px -4px; }
    .action { padding: 4px 6px; font-size: 12px; color: #5f6368; background: transparent; border: 0; }
    .action:hover { color: #1f1f1f; background: rgba(0, 0, 0, 0.06); }
    button:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; }

    @media (prefers-color-scheme: dark) {
      .popup { color: #e8eaed; background: #2b2c2f; border-color: rgba(255, 255, 255, 0.16); }
      .head, .action { color: #bdc1c6; }
      .action:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }
    }
  `;

  function ensureUi() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('corrector-catala-ui');
    host.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;' +
      'z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    const mirrors = document.createElement('div');
    const popup = document.createElement('div');
    popup.className = 'popup';
    popup.hidden = true;
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', 'Suggeriment de correcció');
    // Evita que el campo pierda el foco al pulsar dentro de la tarjeta.
    popup.addEventListener('mousedown', (event) => event.preventDefault());
    root.append(style, mirrors, popup);
    document.documentElement.appendChild(host);
    ui = { host, mirrors, popup };
    return ui;
  }

  function hidePopup() {
    if (ui && !ui.popup.hidden) ui.popup.hidden = true;
  }

  function makeButton(className, label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function showPopup(field, index) {
    const match = field.matches[index];
    const rects = field.rects(index);
    if (!match || !rects.length) return;

    const { host, popup } = ensureUi();
    const kind = kindOf(match);
    const word = field.text.substr(match.offset, match.length);
    popup.textContent = '';

    const head = document.createElement('div');
    head.className = 'head';
    const dot = document.createElement('span');
    dot.className = 'dot ' + kind;
    const title = document.createElement('span');
    title.textContent = match.shortMessage || match.category || KIND_LABEL[kind];
    head.append(dot, title);

    const message = document.createElement('div');
    message.className = 'message';
    message.textContent = match.message;
    popup.append(head, message);

    if (match.replacements.length) {
      const list = document.createElement('div');
      list.className = 'suggestions';
      for (const value of match.replacements) {
        list.appendChild(
          makeButton('suggestion', value, () => {
            hidePopup();
            field.replace(field.matches.indexOf(match), value);
          })
        );
      }
      popup.appendChild(list);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.appendChild(
      makeButton('action', 'Ignora', () => {
        hidePopup();
        ignored.add(match.ruleId + '|' + word);
        field.drop(field.matches.indexOf(match));
      })
    );
    if (kind === 'spell') {
      actions.appendChild(
        makeButton('action', 'Afegeix al diccionari', () => {
          hidePopup();
          field.drop(field.matches.indexOf(match));
          const dictionary = [...new Set([...settings.dictionary, word])];
          settings.dictionary = dictionary;
          try {
            chrome.storage.sync.set({ dictionary });
          } catch (error) {
            alive = false;
          }
        })
      );
    }
    popup.appendChild(actions);

    // Colocación: debajo del error; arriba si no cabe.
    popup.hidden = false;
    const origin = host.getBoundingClientRect();
    const anchor = rects[0];
    const size = popup.getBoundingClientRect();
    let left = Math.min(anchor.left, window.innerWidth - size.width - 8);
    left = Math.max(8, left);
    let top = anchor.bottom + 6;
    if (top + size.height > window.innerHeight - 8 && anchor.top - size.height - 6 > 8) {
      top = anchor.top - size.height - 6;
    }
    popup.style.left = left - origin.left + 'px';
    popup.style.top = top - origin.top + 'px';
  }

  // -------------------------------------------------------- campo: <textarea>

  class TextareaField {
    constructor(el) {
      this.el = el;
      this.gen = 0;
      this.timer = 0;
      this.text = el.value;
      this.matches = [];
      this.spans = [];
      this.box = document.createElement('div');
      this.box.className = 'mirror';
      this.inner = document.createElement('div');
      this.inner.className = 'mirror-inner';
      this.box.appendChild(this.inner);
      ensureUi().mirrors.appendChild(this.box);
      this.observer = new ResizeObserver(() => this.layout());
      this.observer.observe(el);
    }

    readText() {
      return this.el.value;
    }

    onInput() {
      const now = this.el.value;
      this.matches = shiftMatches(this.text, now, this.matches);
      this.text = now;
      this.render();
    }

    show(text, matches) {
      this.text = text;
      this.matches = matches;
      this.render();
    }

    render() {
      this.inner.textContent = '';
      this.spans = [];
      let cursor = 0;
      for (const m of this.matches) {
        if (m.offset > cursor) this.inner.append(this.text.slice(cursor, m.offset));
        const span = document.createElement('span');
        span.className = kindOf(m);
        span.textContent = this.text.substr(m.offset, m.length);
        this.inner.appendChild(span);
        this.spans.push(span);
        cursor = m.offset + m.length;
      }
      // El carácter final evita que se pierda la última línea vacía.
      this.inner.append(this.text.slice(cursor) + '​');
      this.layout();
    }

    layout() {
      const el = this.el;
      const rect = el.getBoundingClientRect();
      if (!el.isConnected || rect.width === 0 || rect.height === 0 || !this.matches.length) {
        this.box.style.display = 'none';
        return;
      }
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') {
        this.box.style.display = 'none';
        return;
      }
      const origin = ensureUi().host.getBoundingClientRect();
      const box = this.box.style;
      box.display = 'block';
      box.left = rect.left - origin.left + parseFloat(cs.borderLeftWidth) + 'px';
      box.top = rect.top - origin.top + parseFloat(cs.borderTopWidth) + 'px';
      box.width = el.clientWidth + 'px';
      box.height = el.clientHeight + 'px';
      const inner = this.inner.style;
      for (const property of COPIED_STYLES) inner[property] = cs[property];
      inner.width = el.clientWidth + 'px';
      inner.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
    }

    rects(index) {
      const span = this.spans[index];
      return span ? [...span.getClientRects()] : [];
    }

    replace(index, value) {
      const m = this.matches[index];
      if (!m) return;
      const el = this.el;
      el.focus();
      el.setSelectionRange(m.offset, m.offset + m.length);
      let done = false;
      try {
        // insertText conserva el "deshacer" (Ctrl+Z) y avisa a React/Vue.
        done = document.execCommand('insertText', false, value);
      } catch (error) {
        done = false;
      }
      if (!done) {
        el.setRangeText(value, m.offset, m.offset + m.length, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    drop(index) {
      if (index < 0) return;
      this.matches.splice(index, 1);
      this.render();
    }

    destroy() {
      clearTimeout(this.timer);
      this.observer.disconnect();
      this.box.remove();
    }
  }

  // --------------------------------------------------- campo: contenteditable

  function extractText(root) {
    const segments = [];
    let text = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const value = child.nodeValue;
          if (value) {
            segments.push({ node: child, start: text.length, end: text.length + value.length });
            text += value;
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.tagName === 'BR') {
            text += '\n';
            continue;
          }
          if (!child.isContentEditable || /^(SCRIPT|STYLE)$/.test(child.tagName)) continue;
          const block = BLOCK_TAGS.test(child.tagName);
          if (block && text && !text.endsWith('\n')) text += '\n';
          walk(child);
          if (block && text && !text.endsWith('\n')) text += '\n';
        }
      }
    };
    walk(root);
    // Los editores usan espacios duros; para corregir cuentan como espacios.
    return { text: text.replace(/ /g, ' '), segments };
  }

  class EditableField {
    constructor(el) {
      this.el = el;
      this.gen = 0;
      this.timer = 0;
      this.text = '';
      this.segments = [];
      this.matches = [];
      this.ranges = [];
    }

    readText() {
      const { text, segments } = extractText(this.el);
      this.segments = segments;
      return text;
    }

    onInput() {
      // Los Range son "vivos": el navegador los recoloca solo al escribir.
    }

    rangeFor(match) {
      const from = match.offset;
      const to = match.offset + match.length;
      const first = this.segments.find((s) => from >= s.start && from < s.end);
      const last = this.segments.find((s) => to > s.start && to <= s.end);
      if (!first || !last) return null;
      const range = document.createRange();
      range.setStart(first.node, from - first.start);
      range.setEnd(last.node, to - last.start);
      return range;
    }

    show(text, matches) {
      this.clear();
      this.text = text;
      for (const m of matches) {
        const range = this.rangeFor(m);
        if (!range) continue;
        const kind = kindOf(m);
        highlights[kind].add(range);
        this.matches.push(m);
        this.ranges.push({ range, kind });
      }
    }

    clear() {
      for (const { range, kind } of this.ranges) highlights[kind].delete(range);
      this.ranges = [];
      this.matches = [];
    }

    layout() {}

    rects(index) {
      const entry = this.ranges[index];
      return entry ? [...entry.range.getClientRects()] : [];
    }

    replace(index, value) {
      const entry = this.ranges[index];
      if (!entry) return;
      this.el.focus();
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(entry.range.cloneRange());
      let done = false;
      try {
        done = document.execCommand('insertText', false, value);
      } catch (error) {
        done = false;
      }
      if (!done) {
        entry.range.deleteContents();
        entry.range.insertNode(document.createTextNode(value));
        this.el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      this.drop(index);
    }

    drop(index) {
      const entry = this.ranges[index];
      if (!entry) return;
      highlights[entry.kind].delete(entry.range);
      this.ranges.splice(index, 1);
      this.matches.splice(index, 1);
    }

    destroy() {
      clearTimeout(this.timer);
      this.clear();
    }
  }

  // ------------------------------------------------------------- orquestación

  function resolveEditable(node) {
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!(node instanceof Element)) return null;
    if (node instanceof HTMLTextAreaElement) return node.readOnly || node.disabled ? null : node;
    if (node.isContentEditable) {
      let root = node;
      while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
      return root;
    }
    return null;
  }

  function attach(node) {
    if (!isActive()) return null;
    const el = resolveEditable(node);
    if (!el) return null;
    const known = fields.get(el);
    if (known) return known;
    if (el.closest(CODE_EDITORS)) return null;
    const isTextarea = el instanceof HTMLTextAreaElement;
    if (!isTextarea && !highlights) return null;
    const field = isTextarea ? new TextareaField(el) : new EditableField(el);
    fields.set(el, field);
    if (!ticker) ticker = setInterval(tick, 1000);
    schedule(field, 0);
    return field;
  }

  function detach(field) {
    field.destroy();
    fields.delete(field.el);
    if (!fields.size && ticker) {
      clearInterval(ticker);
      ticker = 0;
    }
  }

  function schedule(field, delay = DEBOUNCE_MS) {
    clearTimeout(field.timer);
    field.timer = setTimeout(() => check(field), delay);
  }

  async function check(field) {
    if (!isActive() || !fields.has(field.el)) return;
    if (Date.now() < pausedUntil) {
      schedule(field, pausedUntil - Date.now() + 50);
      return;
    }
    const gen = ++field.gen;
    const text = field.readText();
    const matches = await computeMatches(text);
    // Si mientras tanto se ha seguido escribiendo, esta respuesta ya no vale.
    if (!matches || gen !== field.gen || !fields.has(field.el) || field.readText() !== text) return;
    field.show(text, filterMatches(text, matches));
  }

  function tick() {
    for (const field of [...fields.values()]) {
      if (!field.el.isConnected) detach(field);
      else field.layout();
    }
  }

  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      for (const field of fields.values()) field.layout();
    });
  }

  function hitTest(x, y) {
    for (const field of fields.values()) {
      const box = field.el.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      for (let i = 0; i < field.matches.length; i++) {
        for (const r of field.rects(i)) {
          if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 3) {
            return { field, index: i };
          }
        }
      }
    }
    return null;
  }

  function targetOf(event) {
    const path = event.composedPath ? event.composedPath() : [];
    return path[0] || event.target;
  }

  function insideUi(event) {
    return Boolean(ui) && event.composedPath().includes(ui.host);
  }

  document.addEventListener('focusin', (event) => attach(targetOf(event)), true);

  document.addEventListener(
    'input',
    (event) => {
      if (insideUi(event)) return;
      const field = attach(targetOf(event));
      if (!field) return;
      hidePopup();
      field.onInput();
      schedule(field);
    },
    true
  );

  document.addEventListener(
    'click',
    (event) => {
      if (insideUi(event)) return;
      const hit = hitTest(event.clientX, event.clientY);
      if (hit) showPopup(hit.field, hit.index);
      else hidePopup();
    },
    true
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') hidePopup();
    },
    true
  );

  document.addEventListener(
    'scroll',
    () => {
      hidePopup();
      queueLayout();
    },
    true
  );

  window.addEventListener('resize', () => {
    hidePopup();
    queueLayout();
  });

  // ------------------------------------------------------------ configuración

  function applySettings() {
    cache.clear();
    if (!isActive()) {
      hidePopup();
      for (const field of [...fields.values()]) detach(field);
      return;
    }
    for (const field of fields.values()) schedule(field, 0);
    if (document.activeElement) attach(document.activeElement);
  }

  try {
    chrome.storage.sync.get(CORRECTOR_DEFAULTS, (stored) => {
      settings = { ...CORRECTOR_DEFAULTS, ...stored };
      applySettings();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const key of Object.keys(changes)) {
        if (key in CORRECTOR_DEFAULTS) settings[key] = changes[key].newValue ?? CORRECTOR_DEFAULTS[key];
      }
      applySettings();
    });
  } catch (error) {
    alive = false;
  }
})();
