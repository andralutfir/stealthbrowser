'use strict';
/**
 * The control panel.
 *
 * A local HTTP server plus a browser window opened with `--app=`, which is a
 * plain Chromium window with no tabs and no omnibox - a webview in every way
 * that matters, without shipping a runtime to get one. That keeps the whole
 * project on Node with no build step, and it works the same on Windows, Linux
 * and macOS instead of only where a C# compiler happens to live.
 *
 * The window is a browser the user already has, so it is launched on its own
 * throwaway profile: the panel must never touch their real one.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const { PROJECT_ROOT } = require('./config');
const { findBrowser, listBrowsers } = require('./browser');
const { listInterfaces } = require('./net');
const downloader = require('./download');

const UI_DIR = path.join(PROJECT_ROOT, 'app');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Open a folder in the desktop file manager. */
function openFolder(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* it may already exist */ }
  const cmd = process.platform === 'win32' ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { execFile(cmd, [dir], () => {}); } catch { /* nothing to do if it fails */ }
}

class ControlPanel {
  constructor(cfg) {
    this.cfg = cfg;
    // A random path, like the status page. Anything else poking at localhost
    // finds a 404 rather than an API that edits config and starts browsers.
    this.token = crypto.randomBytes(12).toString('hex');
    this.clients = new Set();     // open SSE responses
    this.running = [];            // live session processes
    this.runSeq = 0;
    this.server = http.createServer((req, res) => {
      this._route(req, res).catch((e) => {
        try { this._json(res, 500, { error: e.message }); } catch { /* already sent */ }
      });
    });
    this.server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch {} });
  }

  // ------------------------------------------------------------- plumbing

  _json(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(text);
  }

  /** Push one event to every open panel. */
  emit(type, data) {
    const frame = `data: ${JSON.stringify({ type, ...data })}\n\n`;
    for (const res of this.clients) {
      try { res.write(frame); } catch { this.clients.delete(res); }
    }
  }

  async _route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const prefix = `/${this.token}`;
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const route = url.pathname.slice(prefix.length) || '/';

    if (route === '/' || route === '/index.html') return this._page(res);
    if (['/app.js', '/tailwind.css', '/theme.css', '/schema.js'].includes(route)) {
      return this._static(res, route.slice(1));
    }
    if (route === '/api/events') return this._events(req, res);
    if (route === '/api/state') return this._json(res, 200, this.state());

    if (req.method === 'POST') {
      const body = (await readBody(req)) || '{}';
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* some routes need no body */ }
      switch (route) {
        case '/api/config': return this._json(res, 200, this.saveConfig(payload));
        case '/api/launch': return this._json(res, 200, this.launch());
        case '/api/stop': return this._json(res, 200, this.stopAll());
        case '/api/tool': return this._json(res, 200, await this.runTool(payload.args || []));
        case '/api/open': return this._json(res, 200, this.open(payload.what));
        default: break;
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  _page(res) {
    let html;
    try { html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8'); }
    catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`app/index.html is missing (${e.message})`);
      return;
    }
    // The page needs to know its own random prefix to call the API back, and
    // it needs it everywhere - stylesheet, scripts and the value the client
    // reads - not just at the first mention.
    html = html.split('__BASE__').join(`/${this.token}`);
    // The theme is stamped in so the very first paint is already the right
    // colour; a page that starts light and turns dark is worse than either.
    const theme = (this.cfg.gui || {}).theme;
    html = html.split('__THEME__').join(['light', 'dark', 'system'].includes(theme) ? theme : 'system');
    res.writeHead(200, {
      'content-type': TYPES['.html'],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(html);
  }

  _static(res, name) {
    const file = path.join(UI_DIR, path.basename(name));
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end(`missing: app/${path.basename(name)}`);
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(buf);
    });
  }

  _events(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    // Something has to move on the socket or a proxy in between may drop it.
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(beat); this.clients.delete(res); });
  }

  // ------------------------------------------------------------- API bodies

  state() {
    const { loadConfig, parseArgs } = require('./config');
    let cfg = this.cfg;
    let configFile = null;
    try {
      // parseArgs fills in the shape loadConfig expects; a bare {} throws on
      // the first field it tries to spread.
      const fresh = loadConfig(parseArgs([]));
      const { configFile: f, configMissing, ...rest } = fresh;
      cfg = rest;
      configFile = f;
    } catch (e) { void e; }

    return {
      config: cfg,
      configFile,
      platform: process.platform,
      node: process.version,
      running: this.running.length,
      browsers: listBrowsers(cfg).map((b) => ({
        id: b.id, name: b.name, path: b.path, downloaded: !!b.downloaded,
      })),
      interfaces: listInterfaces().map((i) => ({
        name: i.name, address: i.address, kind: i.kind, status: i.status, description: i.description,
      })),
      installable: Object.keys(downloader.SOURCES || {}),
    };
  }

  saveConfig(cfg) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      return { ok: false, error: 'expected a config object' };
    }
    const target = path.join(PROJECT_ROOT, 'config.json');
    try {
      if (fs.existsSync(target)) fs.copyFileSync(target, target + '.bak');
      fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      this.cfg = cfg;
      return { ok: true, file: target };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** Spawn `node src/index.js` exactly as the scripts do. */
  launch() {
    const save = this.saveConfig(this.cfg);
    if (!save.ok) return save;

    // A second launch while the first is still up gets its own channel prefix,
    // so two runs never interleave into one unreadable stream.
    if (this.running.length === 0) this.runSeq = 1; else this.runSeq++;
    const label = this.runSeq > 1 ? `R${this.runSeq} ` : '';

    let child;
    try {
      child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.js')], {
        cwd: PROJECT_ROOT,
        windowsHide: true,
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }

    const errors = [];
    const feed = (buf, isError) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.length) continue;
        if (isError) errors.push(line.trim());
        this.emit('log', { line, label, error: isError });
      }
    };
    child.stdout.on('data', (b) => feed(b, false));
    child.stderr.on('data', (b) => feed(b, true));
    child.on('exit', (code) => {
      this.running = this.running.filter((p) => p !== child);
      this.emit('exit', { code, errors: errors.slice(0, 14), running: this.running.length });
    });

    this.running.push(child);
    this.emit('started', { running: this.running.length });
    return { ok: true, running: this.running.length };
  }

  stopAll() {
    for (const child of this.running.slice()) {
      try {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {});
        } else {
          child.kill('SIGTERM');
        }
      } catch { /* it may already be gone */ }
    }
    return { ok: true };
  }

  /** One-shot launcher commands: --check, --print-identity, --install-browser. */
  runTool(args) {
    const safe = ['--check', '--print-identity', '--print-config', '--list-browsers',
      '--list-interfaces', '--install-browser'];
    if (!Array.isArray(args) || !args.length || !safe.includes(args[0])) {
      return Promise.resolve({ ok: false, error: 'not an allowed command' });
    }
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.js'), ...args], {
        cwd: PROJECT_ROOT, windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (b) => {
        out += b;
        for (const line of String(b).split(/\r?\n/)) if (line.length) this.emit('log', { line, label: '', error: false });
      });
      child.stderr.on('data', (b) => {
        err += b;
        for (const line of String(b).split(/\r?\n/)) if (line.length) this.emit('log', { line, label: '', error: true });
      });
      child.on('exit', (code) => resolve({ ok: code === 0, code, out, err }));
      child.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
  }

  open(what) {
    const dirs = {
      logs: path.resolve(PROJECT_ROOT, (this.cfg.debug && this.cfg.debug.logDir) || 'logs'),
      macros: path.join(PROJECT_ROOT, 'macros'),
      project: PROJECT_ROOT,
    };
    const dir = dirs[what];
    if (!dir) return { ok: false, error: 'unknown folder' };
    openFolder(dir);
    return { ok: true, dir };
  }

  // ------------------------------------------------------------- lifecycle

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.url = `http://127.0.0.1:${this.port}/${this.token}`;
        resolve(this.url);
      });
    });
  }

  /**
   * Open the panel as an app window: no tabs, no omnibox, its own profile.
   * Falls back to printing the URL when there is no browser to open it with -
   * the panel still works, it just has to be opened by hand.
   */
  openWindow(log) {
    let binary;
    try { binary = findBrowser(this.cfg.browser, this.cfg); }
    catch { binary = null; }
    if (!binary) {
      log('  No browser found to open the panel window.');
      log(`  Open this address yourself: ${this.url}`);
      return null;
    }

    const profile = path.join(os.tmpdir(), 'stealthbrowser-panel');
    try { fs.mkdirSync(profile, { recursive: true }); } catch { /* fine */ }

    const args = [
      `--app=${this.url}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--window-size=1180,820',
    ];
    const child = spawn(binary.path, args, { detached: false, stdio: 'ignore', windowsHide: false });
    child.on('error', (e) => {
      log(`  Could not open the panel window (${e.message}).`);
      log(`  Open this address yourself: ${this.url}`);
    });
    this.window = child;
    return child;
  }

  close() {
    this.stopAll();
    try { if (this.window) this.window.kill(); } catch { /* already gone */ }
    for (const res of this.clients) { try { res.end(); } catch {} }
    try { this.server.close(); } catch { /* already closed */ }
  }
}

module.exports = { ControlPanel };
