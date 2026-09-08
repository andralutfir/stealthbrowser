/* The control panel, client side.
 *
 * Every input is a view onto one in-memory config object rather than a copy of
 * it: an edit lands in `state.config` the moment it happens. That is what lets
 * the Simple and Advanced views show the same setting without either of them
 * being able to overwrite the other with a stale value.
 */
(() => {
  const BASE = window.BASE;
  const S = window.SCHEMA;
  const $ = (id) => document.getElementById(id);

  const state = {
    config: {}, interfaces: [], browsers: [], configFile: '', running: 0,
    mode: 'advanced', theme: window.THEME || 'system',
  };
  let section = 0;
  let dirty = false;

  // ------------------------------------------------------------ style pieces

  const BTN = 'themed rounded-lg border border-zinc-300 px-3 py-2 text-[13px] font-medium text-zinc-700 '
    + 'transition hover:-translate-y-px hover:border-zinc-400 hover:bg-white active:translate-y-0 '
    + 'disabled:opacity-40 disabled:hover:translate-y-0 '
    + 'dark:border-zinc-700 dark:text-zinc-200 dark:hover:border-zinc-500 dark:hover:bg-zinc-800';

  const INPUT = 'themed w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-[13px] text-zinc-900 '
    + 'outline-none transition placeholder:text-zinc-400 focus:border-indigo-400 focus:ring-2 '
    + 'focus:ring-indigo-400/30 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-100 '
    + 'dark:placeholder:text-zinc-500';

  const CARD = 'themed divide-y divide-zinc-200 rounded-xl border border-zinc-200 bg-white px-4 '
    + 'dark:divide-zinc-800/80 dark:border-zinc-800 dark:bg-zinc-900/40';

  const SEG_ON = 'bg-indigo-500 text-white';
  const SEG_OFF = 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100';

  // Written once here rather than eleven times in the markup.
  document.querySelectorAll('[data-btn]').forEach((b) => {
    b.className = BTN + (b.hasAttribute('data-right') ? ' ml-auto' : '');
  });

  // ------------------------------------------------------------ config paths

  const get = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), state.config);

  function set(path, value) {
    const keys = path.split('.');
    let node = state.config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (node[keys[i]] == null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
      node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = value;
    dirty = true;
  }

  // ------------------------------------------------------------ small UI bits

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function status(text) { $('status').textContent = text; }

  /**
   * Show or hide by swapping Tailwind's own classes. The `hidden` attribute
   * would be the obvious way, but its preflight rule and a display utility have
   * the same specificity - so on anything carrying `flex` the attribute loses.
   */
  function show(node, on, display = 'flex') {
    node.classList.toggle('hidden', !on);
    node.classList.toggle(display, on);
  }

  function dialog(title, body, tone) {
    $('dialog-title').textContent = title;
    $('dialog-body').textContent = body;
    $('dialog-dot').className = 'mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full '
      + (tone === 'ok' ? 'bg-emerald-400' : tone === 'bad' ? 'bg-rose-400' : 'bg-amber-400');
    show($('dialog'), true);
    // Re-triggering the animation needs the class off for a frame.
    const card = $('dialog-card');
    card.classList.remove('animate-pop');
    void card.offsetWidth;
    card.classList.add('animate-pop');
  }
  $('dialog-ok').onclick = () => show($('dialog'), false);
  $('dialog').onclick = (e) => { if (e.target === $('dialog')) show($('dialog'), false); };
  addEventListener('keydown', (e) => { if (e.key === 'Escape') show($('dialog'), false); });

  // ------------------------------------------------------------ theme

  const media = matchMedia('(prefers-color-scheme: dark)');

  function paintTheme() {
    const pref = state.theme;
    const dark = pref === 'dark' || (pref !== 'light' && media.matches);
    document.documentElement.classList.toggle('dark', dark);
    for (const b of $('theme-switch').children) {
      const on = b.dataset.theme === pref;
      b.className = 'px-2.5 py-2 transition-colors ' + (on ? SEG_ON : SEG_OFF);
    }
  }
  for (const b of $('theme-switch').children) {
    b.onclick = () => {
      state.theme = b.dataset.theme;
      set('gui.theme', state.theme);
      paintTheme();
    };
  }
  // Only meaningful while following the system, but harmless to keep attached.
  media.addEventListener('change', () => { if (state.theme === 'system') paintTheme(); });

  // ------------------------------------------------------------ field widgets

  function options(field) {
    if (field.dynamic === 'interfaces') {
      const out = [{ value: 'auto', label: 'auto  —  follow the OS default route' }];
      const byKind = {};
      for (const i of state.interfaces) {
        if (i.kind === 'virtual') continue;
        (byKind[i.kind] = byKind[i.kind] || []).push(i);
      }
      for (const [alias, kind] of [['wifi', 'wifi'], ['lan', 'ethernet'], ['vpn', 'vpn']]) {
        const list = byKind[kind] || [];
        list.forEach((i, n) => {
          const value = list.length === 1 ? alias : alias + (n + 1);
          out.push({ value, label: `${value}  —  ${i.name}  (${i.address})` });
        });
      }
      for (const i of state.interfaces) out.push({ value: i.name, label: `${i.name}  (${i.address})` });
      return out;
    }
    return (field.options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  }

  function widget(field) {
    const value = get(field.path);
    const k = field.kind;

    if (k === 'bool') {
      const wrap = el('label', 'group flex cursor-pointer items-start gap-3');
      const box = el('input');
      box.type = 'checkbox';
      box.className = 'mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-indigo-500 transition';
      box.checked = value === undefined ? !!field.fallback : !!value;
      box.onchange = () => set(field.path, box.checked);
      wrap.append(box, el('span', 'text-[13px] leading-snug text-zinc-700 transition-colors '
        + 'group-hover:text-zinc-900 dark:text-zinc-200 dark:group-hover:text-white', field.label));
      return { node: wrap, full: true };
    }

    if (k === 'select' || k === 'tri') {
      const sel = el('select', INPUT + ' cursor-pointer');
      const list = k === 'tri'
        ? [{ value: '', label: 'follow mode' }, { value: 'true', label: 'always on' }, { value: 'false', label: 'always off' }]
        : options(field);
      for (const o of list) {
        const opt = el('option', null, o.label);
        opt.value = o.value;
        sel.append(opt);
      }
      const current = k === 'tri'
        ? (value === null || value === undefined ? '' : String(!!value))
        : (value == null ? (field.fallback || '') : String(value));
      if (k !== 'tri' && current && !list.some((o) => o.value === current)) {
        const opt = el('option', null, current);
        opt.value = current;
        sel.prepend(opt);
      }
      sel.value = current;
      sel.onchange = () => {
        if (k === 'tri') set(field.path, sel.value === '' ? null : sel.value === 'true');
        else set(field.path, sel.value);
      };
      return { node: sel };
    }

    if (k === 'lines' || k === 'csv') {
      const many = k === 'lines';
      const node = el(many ? 'textarea' : 'input', INPUT + (many ? ' resize-y font-mono text-[12px]' : ''));
      if (many) node.rows = field.rows || 3;
      const arr = Array.isArray(value) ? value : [];
      node.value = many ? arr.join('\n') : arr.join(', ');
      node.oninput = () => {
        const parts = node.value.split(many ? '\n' : ',').map((s) => s.trim()).filter(Boolean);
        set(field.path, parts);
      };
      return { node };
    }

    if (k === 'int' || k === 'intOrNull' || k === 'dec') {
      const node = el('input', INPUT + ' w-40');
      node.type = 'number';
      if (field.min !== undefined) node.min = field.min;
      if (field.max !== undefined) node.max = field.max;
      if (k === 'dec') node.step = '0.1';
      node.value = value == null ? (field.fallback == null ? '' : field.fallback) : value;
      node.oninput = () => {
        if (node.value === '') { set(field.path, k === 'intOrNull' ? null : field.fallback ?? 0); return; }
        const n = k === 'dec' ? parseFloat(node.value) : parseInt(node.value, 10);
        if (!Number.isNaN(n)) set(field.path, k === 'intOrNull' && n === 0 ? null : n);
      };
      return { node };
    }

    const node = el('input', INPUT);
    node.type = 'text';
    if (field.placeholder) node.placeholder = field.placeholder;
    node.value = value == null ? (field.fallback || '') : String(value);
    node.oninput = () => {
      const t = node.value.trim();
      set(field.path, k === 'textOrNull' && t === '' ? null : node.value);
    };
    return { node };
  }

  function fieldRow(field) {
    const built = widget(field);
    const row = el('div', 'py-3');

    if (built.full) {
      row.append(built.node);
    } else {
      const grid = el('div', 'grid grid-cols-1 items-center gap-2 sm:grid-cols-[210px_minmax(0,1fr)]');
      grid.append(el('label', 'text-[13px] text-zinc-500 dark:text-zinc-400', field.label));
      const right = el('div', 'flex items-center gap-3');
      right.append(built.node);
      if (field.hint) right.append(el('span', 'shrink-0 text-[12px] text-zinc-400 dark:text-zinc-500', field.hint));
      grid.append(right);
      row.append(grid);
    }
    if (field.help) {
      row.append(el('p', 'mt-1.5 whitespace-pre-line text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-500', field.help));
    }
    return row;
  }

  function presetRow(help) {
    const wrap = el('div', 'py-3');
    const bar = el('div', 'flex flex-wrap gap-2');
    const mk = (label, on) => {
      const b = el('button', 'themed rounded-lg border border-zinc-300 px-3.5 py-2 text-[13px] font-medium '
        + 'text-zinc-700 transition hover:-translate-y-px hover:border-indigo-400 hover:bg-indigo-500/10 '
        + 'hover:text-indigo-600 active:translate-y-0 dark:border-zinc-700 dark:text-zinc-200 '
        + 'dark:hover:text-indigo-300', label);
      b.type = 'button';
      b.onclick = () => applyPreset(on);
      return b;
    };
    bar.append(mk('Full stealth', true), mk('No spoof', false));
    wrap.append(bar);
    if (help) wrap.append(el('p', 'mt-2 text-[12px] leading-relaxed text-zinc-500', help));
    return wrap;
  }

  function buildPage(def) {
    const page = el('div', 'mx-auto max-w-3xl animate-slidein');
    page.append(el('h2', 'text-[20px] font-semibold tracking-tight', def.title));
    if (def.blurb) page.append(el('p', 'mt-1 text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400', def.blurb));

    for (const group of def.groups) {
      const box = el('div', 'mt-6');
      if (group.title) {
        box.append(el('h3', 'mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500', group.title));
      }
      const card = el('div', CARD);
      if (group.presets) card.append(presetRow(group.help));
      for (const f of group.fields) card.append(fieldRow(f));
      box.append(card);
      if (group.help && !group.presets) {
        box.append(el('p', 'mt-2 whitespace-pre-line text-[12px] leading-relaxed text-zinc-500', group.help));
      }
      if (group.warn) box.append(el('p', 'mt-2 text-[12px] leading-relaxed text-amber-500 dark:text-amber-400', group.warn));
      page.append(box);
    }
    return page;
  }

  // ------------------------------------------------------------ presets

  const SPOOF = ['userAgent', 'locale', 'timezone', 'geolocation', 'screen', 'hardware',
    'webgl', 'webglNoise', 'canvasNoise', 'audioNoise'];
  let debugBeforePreset = null;

  function applyPreset(stealth) {
    set('identity.randomize', stealth);
    for (const k of SPOOF) set('identity.spoof.' + k, stealth);
    // Both keep their documented defaults either way: metric noise breaks
    // layouts, and the Client Hints fallback only matters without DevTools.
    set('identity.spoof.fontNoise', false);
    set('identity.spoof.uaDataFallback', false);

    // Recording is not a stealth setting, so the preset borrows it rather than
    // deciding it: whatever it was before "No spoof" is what comes back.
    if (stealth) {
      if (debugBeforePreset !== null) set('debug.enabled', debugBeforePreset);
      debugBeforePreset = null;
    } else {
      if (debugBeforePreset === null) debugBeforePreset = !!get('debug.enabled');
      set('debug.enabled', false);
    }
    render();
    status(stealth
      ? 'Full stealth: every override back on.'
      : 'No spoof: overrides and recording off. Disposable profile and network binding stay.');
  }

  // ------------------------------------------------------------ layout

  function render() {
    const nav = $('nav');
    const pages = $('pages');
    nav.textContent = '';
    pages.textContent = '';

    if (state.mode === 'simple') {
      show(nav, false, 'block');
      pages.append(buildPage(S.simple));
    } else {
      show(nav, true, 'block');
      S.sections.forEach((def, i) => {
        const on = i === section;
        const b = el('button', 'group mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left '
          + 'text-[13px] transition-all ' + (on
            ? 'bg-indigo-500/10 font-semibold text-indigo-600 dark:text-indigo-300'
            : 'text-zinc-500 hover:translate-x-0.5 hover:bg-zinc-200/60 hover:text-zinc-900 '
              + 'dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100'));
        b.type = 'button';
        b.append(el('span', 'h-4 w-0.5 shrink-0 rounded-full transition-colors '
          + (on ? 'bg-indigo-500' : 'bg-transparent')));
        b.append(el('span', 'truncate', def.title));
        b.onclick = () => { section = i; render(); };
        nav.append(b);
      });
      pages.append(buildPage(S.sections[section]));
    }

    $('mode-simple').className = 'px-4 py-2 text-[13px] font-semibold transition-colors '
      + (state.mode === 'simple' ? SEG_ON : SEG_OFF);
    $('mode-advanced').className = 'px-4 py-2 text-[13px] font-semibold transition-colors '
      + (state.mode === 'advanced' ? SEG_ON : SEG_OFF);
  }

  function setMode(mode) {
    state.mode = mode === 'simple' ? 'simple' : 'advanced';
    set('gui.mode', state.mode);
    render();
  }
  $('mode-simple').onclick = () => setMode('simple');
  $('mode-advanced').onclick = () => setMode('advanced');

  // ------------------------------------------------------------ log pane

  const buffers = new Map();
  let active = 'Session';
  let logOpen = false;
  const TAG = /^(?:\[[^\]]*\]\s*\+\s*[\d.]+s\s+)?#(\d+)(?:\s|$)/;

  function drawTabs() {
    const tabs = $('logtabs');
    tabs.textContent = '';
    show(tabs, buffers.size >= 2);
    for (const name of buffers.keys()) {
      const on = name === active;
      const b = el('button', 'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors '
        + (on ? 'bg-indigo-500 text-white'
          : 'bg-zinc-200 text-zinc-600 hover:text-zinc-900 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'), name);
      b.type = 'button';
      b.onclick = () => { active = name; drawTabs(); drawLog(); };
      tabs.append(b);
    }
  }

  function drawLog() {
    const body = $('logbody');
    body.textContent = buffers.get(active) || '';
    body.scrollTop = body.scrollHeight;
  }

  function append(line, label) {
    const m = TAG.exec(line);
    const channel = (label || '') + (m ? '#' + m[1] : 'Session');
    const before = buffers.size;
    let buf = (buffers.get(channel) || '') + line + '\n';
    if (buf.length > 400 * 1024) buf = buf.slice(buf.length - 400 * 1024);
    buffers.set(channel, buf);
    if (buffers.size !== before) { if (buffers.size === 1) active = channel; drawTabs(); }
    if (channel === active) drawLog();
  }

  /** Slide rather than jump: max-height is the only height CSS can animate. */
  function showLog(open) {
    logOpen = open;
    const pane = $('logpane');
    pane.style.maxHeight = open ? pane.scrollHeight + 'px' : '0px';
    pane.style.opacity = open ? '1' : '0';
    document.querySelector('[data-act="toggle-log"]').textContent = open ? 'Hide log' : 'Show log';
    if (open) requestAnimationFrame(drawLog);
  }

  // ------------------------------------------------------------ server calls

  async function api(route, body) {
    const res = await fetch(BASE + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function load() {
    const s = await api('/api/state');
    state.config = s.config || {};
    state.interfaces = s.interfaces || [];
    state.browsers = s.browsers || [];
    state.configFile = s.configFile || '';
    state.running = s.running || 0;
    const gui = state.config.gui || {};
    state.mode = gui.mode === 'simple' ? 'simple' : 'advanced';
    state.theme = ['light', 'dark', 'system'].includes(gui.theme) ? gui.theme : 'system';
    dirty = false;
    paintTheme();
    render();
    status(state.configFile ? 'Config: ' + state.configFile : 'No config file found — running on defaults.');
    document.querySelector('[data-act="stop"]').disabled = state.running === 0;
  }

  async function save(quiet) {
    const r = await api('/api/config', state.config);
    if (!r.ok) { dialog('Could not save config.json', r.error || 'unknown error', 'bad'); return false; }
    dirty = false;
    if (!quiet) status('Saved to ' + r.file);
    return true;
  }

  const ACTIONS = {
    async launch() {
      if (!(await save(true))) return;
      showLog(true);
      const r = await api('/api/launch', {});
      if (!r.ok) { dialog('Could not start the session', r.error || 'unknown error', 'bad'); return; }
      document.querySelector('[data-act="stop"]').disabled = false;
      status('Session running. Closing every browser window ends it and wipes the profile.');
    },
    async stop() {
      await api('/api/stop', {});
      status('Stopping…');
    },
    async save() { await save(); },
    async reload() { await load(); status('Reloaded from disk.'); },
    async check() {
      showLog(true);
      status('Running the setup check…');
      const r = await api('/api/tool', { args: ['--check'] });
      const fails = String(r.out || '').split('\n').filter((l) => l.trim().startsWith('[FAIL]'));
      if (fails.length) dialog('Setup check found problems', fails.join('\n'), 'bad');
      status(fails.length ? fails.length + ' check(s) failed — see the dialog.' : 'Setup check passed.');
    },
    async 'get-browser'() {
      showLog(true);
      status('Downloading a portable browser — nothing is installed.');
      const r = await api('/api/tool', { args: ['--install-browser'] });
      if (!r.ok) dialog('Browser download failed', (r.err || r.error || '').trim() || 'see the log', 'bad');
      else status('Browser ready.');
      await load();
    },
    async identity() {
      showLog(true);
      await api('/api/tool', { args: ['--print-identity'] });
      status('Persona printed to the log.');
    },
    async logs() { await api('/api/open', { what: 'logs' }); },
    async macros() { await api('/api/open', { what: 'macros' }); },
    clear() { buffers.clear(); active = 'Session'; drawTabs(); drawLog(); },
    'toggle-log'() { showLog(!logOpen); },
  };

  document.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      const fn = ACTIONS[b.dataset.act];
      if (fn) Promise.resolve(fn()).catch((e) => dialog('Something failed', e.message, 'bad'));
    };
  });

  // ------------------------------------------------------------ live output

  const events = new EventSource(BASE + '/api/events');
  events.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'log') append(msg.line, msg.label);
    if (msg.type === 'started') document.querySelector('[data-act="stop"]').disabled = false;
    if (msg.type === 'exit') {
      document.querySelector('[data-act="stop"]').disabled = msg.running > 0;
      if (msg.running === 0) status('Session ended.');
      if (msg.errors && msg.errors.length) {
        dialog('Session reported a problem', msg.errors.join('\n'), 'bad');
      } else if (msg.code !== 0 && msg.code !== null) {
        dialog('Session reported a problem', 'Exited with code ' + msg.code, 'bad');
      }
    }
  };

  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  drawTabs();
  load().catch((e) => status('Could not reach the panel server: ' + e.message));
})();
