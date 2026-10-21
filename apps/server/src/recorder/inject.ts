// Runs inside the page under test. Captures user actions and reports them to
// the recorder through the `__izaroRecord` binding. Kept as plain JS in a
// string because it is evaluated in the browser, not in Node.
export const RECORDER_SCRIPT = String.raw`
(() => {
  if (window.__izaro) return;

  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const quote = (s) => JSON.stringify(s);
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const implicitRole = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['', 'text', 'email', 'search', 'tel', 'url'].includes(type)) return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return null;
  };

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    if (el.id) {
      const label = document.querySelector('label[for=' + quote(el.id) + ']');
      if (label) return clean(label.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping) return clean(wrapping.textContent);
    if (el.tagName === 'INPUT' && ['submit', 'button'].includes(el.type)) return clean(el.value);
    if (['BUTTON', 'A'].includes(el.tagName) || /^H[1-6]$/.test(el.tagName)) return clean(el.textContent);
    return '';
  };

  const unique = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  };

  const cssPath = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.body; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + cssEscape(node.id)); break; }
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  };

  // Ranked like Playwright codegen: test ids, then role + name, then stable
  // attributes, then text, then a structural CSS path as last resort.
  const selectorsFor = (el) => {
    const out = [];
    const add = (s, check) => { if (s && !out.includes(s) && (!check || unique(check))) out.push(s); };
    for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-qa']) {
      const v = el.getAttribute(attr);
      if (v) add('[' + attr + '=' + quote(v) + ']', '[' + attr + '=' + quote(v) + ']');
    }
    const role = el.getAttribute('role') || implicitRole(el);
    const name = accessibleName(el);
    if (role && name && name.length <= 80) add('role=' + role + '[name=' + quote(name) + ']');
    if (el.id && !/\d{3,}/.test(el.id)) add('#' + cssEscape(el.id), '#' + cssEscape(el.id));
    const tag = el.tagName.toLowerCase();
    for (const attr of ['name', 'placeholder', 'aria-label', 'title', 'alt']) {
      const v = el.getAttribute(attr);
      if (v) { const s = tag + '[' + attr + '=' + quote(v) + ']'; add(s, s); }
    }
    const text = clean(el.innerText || el.textContent);
    if (text && text.length <= 50 && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) add('text=' + quote(text));
    add(cssPath(el));
    return out;
  };

  // Clicks land on inner spans/icons; record the nearest interactive ancestor.
  const target = (el) =>
    (el && el.closest && el.closest('button, a, input, select, textarea, label, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem], [onclick]')) || el;

  const send = (evt) => { try { window.__izaroRecord(evt); } catch (e) {} };

  window.__izaro = {
    selectorsFor,
    inspect(x, y) {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        selectors: selectorsFor(el),
        tag: el.tagName.toLowerCase(),
        text: clean(el.innerText || el.textContent).slice(0, 200),
        value: 'value' in el ? String(el.value) : undefined,
        box: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    },
  };

  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const el = target(e.target);
    if (!el || el === document.documentElement || el === document.body) return;
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'SELECT' || (tag === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image'].includes(type)) || tag === 'TEXTAREA') return;
    if (tag === 'INPUT' && type === 'checkbox') {
      send({ action: el.checked ? 'check' : 'uncheck', selectors: selectorsFor(el), label: accessibleName(el) || 'checkbox' });
      return;
    }
    send({ action: 'click', selectors: selectorsFor(el), label: accessibleName(el) || clean(el.innerText).slice(0, 40) || tag.toLowerCase() });
  }, true);

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!e.isTrusted || !el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
    if (['checkbox', 'radio'].includes(el.type)) return;
    send({ action: 'fill', selectors: selectorsFor(el), value: el.value, secret: el.type === 'password', label: accessibleName(el) || el.name || 'field' });
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!e.isTrusted || !el || el.tagName !== 'SELECT') return;
    send({ action: 'select', selectors: selectorsFor(el), value: el.value, label: accessibleName(el) || el.name || 'select' });
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || !['Enter', 'Escape', 'Tab'].includes(e.key)) return;
    const el = e.target;
    if (!el || el === document.body) return;
    send({ action: 'press', selectors: selectorsFor(el), value: e.key, label: e.key });
  }, true);
})();
`;
