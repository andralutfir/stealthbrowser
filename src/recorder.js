'use strict';
/**
 * Session recorder: the page-side half.
 *
 * Injected before any page script and reports back over a CDP binding, so it
 * sees interactions even on pages that rewrite their own DOM. Everything is
 * wrapped in try/catch and every listener is passive and capture-phase: a
 * recorder that changes how the page behaves is worse than no recorder.
 *
 * The binding name is randomised per session. A fixed `window.__sbLog` would be
 * a global any site could probe for, which is exactly the kind of tell the rest
 * of this project works to remove.
 */

/* eslint-disable no-undef */
function recorderPayload(CFG) {
  'use strict';
  const BINDING = CFG.binding;
  if (window[CFG.flag]) return;
  try {
    Object.defineProperty(window, CFG.flag, { value: true, enumerable: false, configurable: false });
  } catch (_) { return; }

  const send = (kind, data) => {
    try {
      const fn = window[BINDING];
      if (typeof fn !== 'function') return;
      fn(JSON.stringify(Object.assign({ kind, ts: Date.now(), url: location.href }, data)));
    } catch (_) { /* never let logging break the page */ }
  };

  // ---------------------------------------------------------------- redaction

  const SECRET_RE = /pass|pwd|secret|token|otp|cvv|cvc|ccv|card|credit|ssn|pin\b|auth|credential|security.?(code|answer)|mother.?maiden/i;

  const isSecret = (el) => {
    if (!el) return false;
    if (el.type === 'password') return true;
    const ac = (el.getAttribute && el.getAttribute('autocomplete')) || '';
    if (/^(current|new)-password$|^cc-|^one-time-code$/.test(ac)) return true;
    const hay = [el.name, el.id, el.className, el.placeholder,
      el.getAttribute && el.getAttribute('aria-label')].filter(Boolean).join(' ');
    return SECRET_RE.test(hay);
  };

  const clip = (v) => {
    const s = String(v == null ? '' : v);
    return s.length > CFG.maxValue ? s.slice(0, CFG.maxValue) + `…(+${s.length - CFG.maxValue})` : s;
  };

  /** @returns {{value:string, redacted:boolean, length:number}} */
  const readValue = (el) => {
    const raw = el && el.value != null ? String(el.value) : '';
    if (!CFG.captureValues) return { value: null, redacted: false, length: raw.length };
    if (CFG.redactSecrets && isSecret(el)) return { value: null, redacted: true, length: raw.length };
    return { value: clip(raw), redacted: false, length: raw.length };
  };

  // -------------------------------------------------------------- describing

  const text = (el) => {
    try {
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      return t.length > 60 ? t.slice(0, 60) + '…' : t;
    } catch (_) { return ''; }
  };

  /** Human label for a control, in the order a person would recognise it. */
  const labelOf = (el) => {
    try {
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const ref = document.getElementById(labelledBy.split(/\s+/)[0]);
        if (ref) return text(ref);
      }
      if (el.labels && el.labels.length) return text(el.labels[0]);
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return text(lbl);
      }
      const wrap = el.closest && el.closest('label');
      if (wrap) return text(wrap);
      if (el.placeholder) return el.placeholder;
      if (el.title) return el.title;
      if (el.alt) return el.alt;
      if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) return el.value || '';
      // Falling back to innerText only makes sense for things that carry their
      // own caption. On a <form> or a wrapper <div> it scrapes the whole page.
      if (/^(A|BUTTON|SUMMARY|LABEL|OPTION|TD|TH|LI|H[1-6]|SPAN|STRONG|EM)$/.test(el.tagName)
        || (el.getAttribute && /^(button|link|tab|menuitem|option)$/.test(el.getAttribute('role') || ''))) {
        return text(el);
      }
      return '';
    } catch (_) { return ''; }
  };

  /** Compact, human-readable identity: what you would call this thing out loud. */
  const describe = (el) => {
    // Document-level events (keyboard shortcuts, for instance) have no element
    // worth naming; "page" reads better than a bare question mark.
    if (!el || !el.tagName) return 'page';
    if (el.tagName === 'BODY' || el.tagName === 'HTML') return 'page';
    let s = el.tagName.toLowerCase();
    if (el.type && el.tagName !== 'BUTTON') s += `[${el.type}]`;
    if (el.id) s += `#${el.id}`;
    else if (el.name) s += `[name=${el.name}]`;
    else if (typeof el.className === 'string' && el.className.trim()) {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) s += `.${cls}`;
    }
    const label = labelOf(el);
    if (label) s += ` "${label.length > 60 ? label.slice(0, 60) + '…' : label}"`;
    return s;
  };

  /** A selector you can paste into devtools to find the element again. */
  const selectorOf = (el) => {
    try {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let node = el;
      let depth = 0;
      while (node && node.nodeType === 1 && depth < 5 && node !== document.body) {
        let part = node.tagName.toLowerCase();
        if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        if (typeof node.className === 'string' && node.className.trim()) {
          const c = node.className.trim().split(/\s+/)[0];
          if (c && !/^\d/.test(c)) part += `.${CSS.escape(c)}`;
        }
        const parent = node.parentElement;
        if (parent) {
          const sames = Array.prototype.filter.call(parent.children, (n) => n.tagName === node.tagName);
          if (sames.length > 1) part += `:nth-of-type(${sames.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
        depth++;
      }
      return parts.join(' > ');
    } catch (_) { return ''; }
  };

  /** Walk up to the control a person meant to hit, not the inner <span>. */
  const meaningful = (el) => {
    try {
      const hit = el.closest && el.closest(
        'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[onclick],label,summary');
      return hit || el;
    } catch (_) { return el; }
  };

  const on = (target, type, fn) => {
    try { target.addEventListener(type, fn, { capture: true, passive: true }); } catch (_) {}
  };

  // ------------------------------------------------------------------ clicks

  on(document, 'click', (e) => {
    const el = meaningful(e.target);
    const link = el.closest && el.closest('a[href]');
    const mods = ['ctrlKey', 'shiftKey', 'altKey', 'metaKey']
      .filter((k) => e[k]).map((k) => k.replace('Key', ''));
    send('click', {
      target: describe(el),
      selector: selectorOf(el),
      href: link ? link.getAttribute('href') : undefined,
      at: [Math.round(e.clientX), Math.round(e.clientY)],
      modifiers: mods.length ? mods : undefined,
      disabled: el.disabled || undefined,
    });
  });

  on(document, 'contextmenu', (e) => {
    send('rightclick', { target: describe(meaningful(e.target)) });
  });

  on(document, 'dblclick', (e) => {
    send('dblclick', { target: describe(meaningful(e.target)) });
  });

  // ------------------------------------------------------------------ typing

  // One pending timer per field. Typing emits a single event once the user
  // pauses, instead of one per keystroke; `change` flushes it immediately.
  const timers = new WeakMap();
  const lastSent = new WeakMap();

  const emitValue = (el, kind) => {
    if (!el || !el.tagName) return;
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !el.isContentEditable) return;

    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      send('toggle', { target: describe(el), selector: selectorOf(el), checked: !!el.checked });
      return;
    }
    if (tag === 'SELECT') {
      const opt = el.options && el.options[el.selectedIndex];
      send('select', {
        target: describe(el), selector: selectorOf(el),
        option: opt ? clip(opt.text) : null, value: CFG.captureValues ? clip(el.value) : null,
      });
      return;
    }
    if (tag === 'INPUT' && el.type === 'file') {
      const names = el.files ? Array.prototype.map.call(el.files, (f) => f.name) : [];
      send('file', { target: describe(el), files: names });
      return;
    }

    const v = el.isContentEditable
      ? { value: CFG.captureValues ? clip(el.innerText || '') : null, redacted: false, length: (el.innerText || '').length }
      : readValue(el);
    if (lastSent.get(el) === v.value && v.value !== null) return;
    lastSent.set(el, v.value);
    send(kind, {
      target: describe(el), selector: selectorOf(el),
      value: v.value, redacted: v.redacted || undefined, length: v.length,
    });
  };

  on(document, 'input', (e) => {
    const el = e.target;
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => emitValue(el, 'type'), CFG.typeIdleMs));
  });

  on(document, 'change', (e) => {
    const el = e.target;
    clearTimeout(timers.get(el));
    emitValue(el, 'change');
  });

  // ------------------------------------------------------------------- forms

  on(document, 'submit', (e) => {
    const f = e.target;
    const fields = [];
    try {
      for (const el of Array.from(f.elements || [])) {
        if (!el.name || el.disabled) continue;
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.checked) fields.push({ name: el.name, value: CFG.captureValues ? clip(el.value) : null });
          continue;
        }
        if (el.type === 'submit' || el.type === 'button') continue;
        const v = readValue(el);
        fields.push({ name: el.name, type: el.type, value: v.value, redacted: v.redacted || undefined, length: v.length });
      }
    } catch (_) {}
    send('submit', {
      target: describe(f),
      action: (f.getAttribute && f.getAttribute('action')) || location.href,
      method: ((f.method || 'get') + '').toUpperCase(),
      fields,
    });
  });

  // -------------------------------------------------------------------- keys

  if (CFG.captureKeys) {
    const NAMED = /^(Enter|Escape|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End|F\d{1,2})$/;
    on(document, 'keydown', (e) => {
      const mods = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.metaKey) mods.push('Meta');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey && (mods.length || NAMED.test(e.key))) mods.push('Shift');
      // Only named keys and real shortcuts. Logging ordinary characters would
      // capture every password typed anywhere on the page.
      const isShortcut = e.ctrlKey || e.metaKey || e.altKey;
      if (!isShortcut && !NAMED.test(e.key)) return;
      const combo = mods.concat(e.key.length === 1 ? e.key.toUpperCase() : e.key).join('+');
      send('key', { combo, target: describe(meaningful(e.target)) });
    });
  }

  // ------------------------------------------------------------ scroll depth

  if (CFG.captureScroll) {
    let maxPct = 0;
    let pending = false;
    const check = () => {
      pending = false;
      try {
        const doc = document.documentElement;
        const total = Math.max(1, doc.scrollHeight - window.innerHeight);
        const pct = Math.min(100, Math.round((window.scrollY / total) * 100));
        // Milestones only; a line per scroll tick would drown the log.
        const step = Math.floor(pct / 25) * 25;
        if (step > maxPct) { maxPct = step; send('scroll', { depth: step }); }
      } catch (_) {}
    };
    on(window, 'scroll', () => {
      if (pending) return;
      pending = true;
      setTimeout(check, 400);
    });
  }

  // ------------------------------------------------------- page-level events

  on(document, 'copy', () => send('clipboard', { action: 'copy' }));
  on(document, 'cut', () => send('clipboard', { action: 'cut' }));
  on(document, 'paste', (e) => {
    let len;
    try { len = (e.clipboardData && e.clipboardData.getData('text') || '').length; } catch (_) {}
    send('clipboard', { action: 'paste', length: len });
  });

  on(window, 'resize', (() => {
    let t;
    return () => {
      clearTimeout(t);
      t = setTimeout(() => send('resize', { size: [window.innerWidth, window.innerHeight] }), 500);
    };
  })());

  on(document, 'visibilitychange', () => send('visibility', { state: document.visibilityState }));

  const started = Date.now();
  const ready = () => send('pageready', {
    title: document.title,
    readyState: document.readyState,
    // How long the document itself took, as the page measures it.
    ms: (() => {
      try {
        const nav = performance.getEntriesByType('navigation')[0];
        return nav ? Math.round(nav.duration) : undefined;
      } catch (_) { return undefined; }
    })(),
  });
  if (document.readyState === 'complete') ready();
  else on(window, 'load', ready);

  on(window, 'pagehide', () => send('leave', { title: document.title, dwellMs: Date.now() - started }));
}
/* eslint-enable no-undef */

/**
 * @param {object} opts binding, flag, captureValues, redactSecrets, maxValue,
 *                      captureKeys, captureScroll, typeIdleMs
 */
function buildRecorderScript(opts) {
  const cfg = {
    binding: opts.binding,
    flag: opts.flag,
    captureValues: opts.captureValues !== false,
    redactSecrets: opts.redactSecrets !== false,
    maxValue: Number.isFinite(opts.maxValue) ? opts.maxValue : 200,
    captureKeys: opts.captureKeys !== false,
    captureScroll: opts.captureScroll !== false,
    typeIdleMs: Number.isFinite(opts.typeIdleMs) ? opts.typeIdleMs : 900,
  };
  return `(${recorderPayload.toString()})(${JSON.stringify(cfg)});`;
}

// ---------------------------------------------------------------- formatting

const VERB = {
  click: 'CLICK', rightclick: 'RCLICK', dblclick: 'DBLCLK', type: 'TYPE',
  change: 'CHANGE', toggle: 'TOGGLE', select: 'SELECT', file: 'FILE',
  submit: 'SUBMIT', key: 'KEY', scroll: 'SCROLL', clipboard: 'CLIP',
  resize: 'RESIZE', visibility: 'TAB', pageready: 'READY', leave: 'LEAVE',
};

function shortUrl(u) {
  try {
    const url = new URL(u);
    const p = url.pathname + (url.search ? '?…' : '');
    return url.host + (p === '/' ? '' : p);
  } catch { return String(u || ''); }
}

/** One human-readable line for a recorded page event. */
function formatEvent(ev) {
  const verb = VERB[ev.kind] || ev.kind.toUpperCase();
  switch (ev.kind) {
    case 'click':
    case 'rightclick':
    case 'dblclick': {
      let s = ev.target;
      if (ev.href) s += ` -> ${ev.href}`;
      if (ev.modifiers) s += ` [${ev.modifiers.join('+')}]`;
      if (ev.disabled) s += ' (disabled)';
      return { verb, text: s };
    }
    case 'type':
    case 'change': {
      const val = ev.redacted
        ? `${'*'.repeat(Math.min(8, ev.length || 8))} (redacted, ${ev.length} chars)`
        : ev.value === null ? `(${ev.length} chars)` : JSON.stringify(ev.value);
      return { verb, text: `${ev.target} = ${val}` };
    }
    case 'toggle':
      return { verb, text: `${ev.target} -> ${ev.checked ? 'checked' : 'unchecked'}` };
    case 'select':
      return { verb, text: `${ev.target} -> ${JSON.stringify(ev.option)}` };
    case 'file':
      return { verb, text: `${ev.target} -> ${(ev.files || []).join(', ') || '(none)'}` };
    case 'submit': {
      const parts = (ev.fields || []).map((f) => {
        if (f.redacted) return `${f.name}=<redacted:${f.length}>`;
        if (f.value === null) return `${f.name}=<${f.length} chars>`;
        return `${f.name}=${JSON.stringify(f.value)}`;
      });
      return { verb, text: `${ev.target} ${ev.method} ${shortUrl(ev.action)}  {${parts.join(', ')}}` };
    }
    case 'key':
      return { verb, text: `${ev.combo}  on ${ev.target}` };
    case 'scroll':
      return { verb, text: `${ev.depth}% of page` };
    case 'clipboard':
      return { verb, text: ev.length !== undefined ? `${ev.action} (${ev.length} chars)` : ev.action };
    case 'resize':
      return { verb, text: `${ev.size[0]}x${ev.size[1]}` };
    case 'visibility':
      return { verb, text: ev.state };
    case 'pageready':
      return { verb, text: `${JSON.stringify(ev.title || '')}${ev.ms ? `  (${ev.ms} ms)` : ''}` };
    case 'leave':
      return { verb, text: `${shortUrl(ev.url)}  after ${(ev.dwellMs / 1000).toFixed(1)}s` };
    default:
      return { verb, text: JSON.stringify(ev) };
  }
}

module.exports = { buildRecorderScript, formatEvent, shortUrl };
