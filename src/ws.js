'use strict';
/**
 * Minimal RFC6455 WebSocket client (dependency-free).
 * Only what CDP needs: text frames, fragmentation, ping/pong, close.
 */
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BIN = 0x2;
const OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

class WebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.socket = null;
    this.closed = false;
    this._buf = Buffer.alloc(0);
    this._frags = [];
    this._fragOp = 0;
    this._connect();
  }

  _connect() {
    const u = new URL(this.url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: (u.pathname || '/') + (u.search || ''),
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Host: u.host,
        // No Origin header on purpose: since Chrome 111 the DevTools endpoint
        // rejects (403) any upgrade carrying an Origin that is not in
        // --remote-allow-origins. Native CDP clients omit it entirely.
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true);
      this.socket = socket;
      socket.on('data', (d) => this._onData(d));
      socket.on('close', () => { this.closed = true; this.emit('close'); });
      socket.on('error', (e) => this.emit('error', e));
      this.emit('open');
    });
    req.on('response', (res) => {
      this.emit('error', new Error(`WebSocket upgrade rejected (HTTP ${res.statusCode})`));
      res.resume();
    });
    req.on('error', (e) => this.emit('error', e));
    req.end();
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = b.readUInt32BE(2) * 4294967296 + b.readUInt32BE(6); off = 10;
      }
      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.subarray(off, off + 4); off += 4;
      }
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this._buf = b.subarray(off + len);
      this._frame(fin, op, payload);
    }
  }

  _frame(fin, op, payload) {
    if (op === OP_PING) { this._send(OP_PONG, payload); return; }
    if (op === OP_PONG) return;
    if (op === OP_CLOSE) { this.close(); return; }
    if (op === OP_CONT) this._frags.push(payload);
    else { this._fragOp = op; this._frags = [payload]; }
    if (!fin) return;
    const data = this._frags.length === 1 ? this._frags[0] : Buffer.concat(this._frags);
    this._frags = [];
    if (this._fragOp === OP_TEXT) this.emit('message', data.toString('utf8'));
    else if (this._fragOp === OP_BIN) this.emit('binary', data);
  }

  send(str) { this._send(OP_TEXT, Buffer.from(str, 'utf8')); }

  _send(op, payload) {
    if (!this.socket || this.socket.destroyed) return;
    const len = payload.length;
    const mask = crypto.randomBytes(4);
    let header;
    if (len < 126) { header = Buffer.alloc(6); header[1] = 0x80 | len; }
    else if (len < 65536) { header = Buffer.alloc(8); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else {
      header = Buffer.alloc(14); header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(len / 4294967296), 2);
      header.writeUInt32BE(len % 4294967296, 6);
    }
    header[0] = 0x80 | op;
    mask.copy(header, header.length - 4);
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, out]));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this._send(OP_CLOSE, Buffer.alloc(0)); } catch {}
    try { this.socket && this.socket.destroy(); } catch {}
    this.emit('close');
  }
}

module.exports = { WebSocket };
