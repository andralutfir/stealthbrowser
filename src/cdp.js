'use strict';
/**
 * Tiny Chrome DevTools Protocol client.
 * Connects to the browser-level endpoint and uses flat auto-attach so every
 * page/iframe target gets its overrides applied BEFORE any page script runs.
 */
const http = require('http');
const { EventEmitter } = require('events');
const { WebSocket } = require('./ws');

function httpJson(port, path, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function waitForBrowser(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await httpJson(port, '/json/version');
      if (v && v.webSocketDebuggerUrl) return v;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Browser did not respond on debug port ${port}: ${lastErr && lastErr.message}`);
}

class CDP extends EventEmitter {
  constructor(wsUrl) {
    super();
    // An EventEmitter with no 'error' listener throws on emit and takes the
    // process down; a transport hiccup must never do that to the launcher.
    this.on('error', () => {});
    this.lastError = null;
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => this._onMessage(raw));
    this.ws.on('close', () => {
      this.disconnected = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP disconnected'));
      this.pending.clear();
      this.emit('disconnect');
    });
    this.ws.on('error', (e) => { this.lastError = e; this.emit('error', e); });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) this.emit('event', msg);
  }

  send(method, params = {}, sessionId, timeoutMs = 15000) {
    // Once the transport is gone nothing will ever answer. Without this check a
    // command issued after the browser died would sit in `pending` forever and
    // hang shutdown - the profile would then never get wiped.
    if (this.disconnected || this.ws.closed) {
      return Promise.reject(new Error('CDP disconnected'));
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  /** Fire-and-forget: some targets die mid-command, and that is not an error we care about. */
  async trySend(method, params, sessionId, timeoutMs) {
    try {
      return await this.send(method, params, sessionId, timeoutMs);
    } catch (e) {
      if (this.verbose) console.log(`[cdp] FAIL ${method}${sessionId ? ` @${sessionId.slice(0, 8)}` : ''}: ${e.message}`);
      return null;
    }
  }

  close() { try { this.ws.close(); } catch {} }
}

module.exports = { CDP, waitForBrowser, httpJson };
