'use strict';
/**
 * Session logger: writes the readable .log and the structured .jsonl sidecar.
 *
 * Redaction lives in recorder.js, which decides what a value is allowed to be
 * before it ever reaches here. This module only formats and persists. What it
 * never adds on its own: cookie values, request bodies, or URL query strings -
 * safeUrl() strips those so a log cannot quietly become a token store.
 */
const fs = require('fs');
const path = require('path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

class Logger {
  /**
   * @param {object}  opts
   * @param {boolean} opts.enabled
   * @param {string?} opts.file      explicit path, or null to auto-name
   * @param {string?} opts.dir       directory for auto-named files
   * @param {string}  opts.level     error | warn | info | debug
   * @param {boolean} opts.toConsole also print to stdout
   * @param {string}  opts.tag       instance label, e.g. "#2"
   */
  constructor(opts = {}) {
    this.enabled = !!opts.enabled;
    this.level = LEVELS[opts.level] !== undefined ? LEVELS[opts.level] : LEVELS.info;
    this.toConsole = opts.toConsole !== false;
    this.tag = opts.tag || '';
    this.stream = null;
    this.jsonlStream = null;
    this.path = null;
    this.jsonlPath = null;
    this.startedAt = Date.now();
    this.counts = { total: 0, error: 0, warn: 0 };

    if (!this.enabled) return;
    try {
      if (opts.file) {
        this.path = path.resolve(opts.file);
      } else {
        const dir = path.resolve(opts.dir || 'logs');
        fs.mkdirSync(dir, { recursive: true });
        this.path = path.join(dir, `${fileStamp()}${opts.tag ? '_' + opts.tag.replace(/[^\w-]/g, '') : ''}.log`);
      }
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      this.stream = fs.createWriteStream(this.path, { flags: 'a' });
      if (opts.jsonl !== false) {
        // Machine-readable sidecar: one JSON object per line, so the recording
        // can be queried with jq or replayed by tooling instead of eyeballed.
        this.jsonlPath = this.path.replace(/\.log$/, '') + '.jsonl';
        this.jsonlStream = fs.createWriteStream(this.jsonlPath, { flags: 'a' });
      }
    } catch (e) {
      console.error(`  WARNING      : cannot write the log file (${e.message}); debug output goes to the console only`);
      this.stream = null;
    }
  }

  header(lines) {
    if (!this.enabled) return;
    const bar = '='.repeat(72);
    this.raw(`\n${bar}`);
    for (const l of lines) this.raw(l);
    this.raw(`${bar}\n`);
  }

  raw(text) {
    if (!this.enabled) return;
    // The file already belongs to one instance, so it stays unprefixed. The
    // console is shared between instances, so a multi-instance run prefixes
    // every line - that is what lets a reader (or the GUI) split them apart.
    if (this.stream) this.stream.write(text + '\n');
    if (!this.toConsole) return;
    const tagged = /^#\d+$/.test(this.tag);
    console.log(tagged
      ? String(text).split('\n').map((l) => `${this.tag} ${l}`).join('\n')
      : text);
  }

  /**
   * @param {string} level  error | warn | info | debug
   * @param {string} kind   short category, e.g. "console", "net", "nav", "ui"
   * @param {string} message
   * @param {object?} extra appended as compact key=value pairs
   */
  log(level, kind, message, extra) {
    if (!this.enabled) return;
    if ((LEVELS[level] ?? 2) > this.level) return;
    this.counts.total++;
    if (level === 'error') this.counts.error++;
    if (level === 'warn') this.counts.warn++;

    // Wall clock plus offset from session start: a recording is easier to read
    // by "12 seconds in" than by absolute time.
    const rel = ((Date.now() - this.startedAt) / 1000).toFixed(1).padStart(6);
    let line = `[${stamp()}] +${rel}s${this.tag ? ` ${this.tag}` : ''} ${level.toUpperCase().padEnd(5)} ${kind.padEnd(8)} ${message}`;
    if (extra) {
      const parts = [];
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined || v === null || v === '') continue;
        parts.push(`${k}=${typeof v === 'string' && v.includes(' ') ? JSON.stringify(v) : v}`);
      }
      if (parts.length) line += `  ${parts.join(' ')}`;
    }
    if (this.stream) this.stream.write(line + '\n');
    if (this.toConsole) console.log(line);
  }

  /** Structured record for the .jsonl sidecar. Never printed to the terminal. */
  event(record) {
    if (!this.jsonlStream) return;
    try {
      this.jsonlStream.write(JSON.stringify(Object.assign({
        at: Date.now() - this.startedAt,
        iso: new Date().toISOString(),
      }, record)) + '\n');
    } catch { /* a logging failure must never break the session */ }
  }

  error(kind, msg, extra) { this.log('error', kind, msg, extra); }
  warn(kind, msg, extra) { this.log('warn', kind, msg, extra); }
  info(kind, msg, extra) { this.log('info', kind, msg, extra); }
  debug(kind, msg, extra) { this.log('debug', kind, msg, extra); }

  close() {
    return Promise.all([
      new Promise((r) => (this.stream ? this.stream.end(r) : r())),
      new Promise((r) => (this.jsonlStream ? this.jsonlStream.end(r) : r())),
    ]);
  }
}

function truncate(s, n = 300) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + `...(+${s.length - n})` : s;
}

/** Strip query strings and credentials so logs do not become a token store. */
function safeUrl(url, keepQuery = false) {
  if (typeof url !== 'string') return String(url);
  if (url.startsWith('data:')) return `data:...(${url.length}b)`;
  if (url.startsWith('blob:')) return 'blob:...';
  try {
    const u = new URL(url);
    u.username = ''; u.password = '';
    if (!keepQuery) u.search = u.search ? '?…' : '';
    u.hash = '';
    return truncate(u.toString(), 200);
  } catch { return truncate(url, 200); }
}

module.exports = { Logger, truncate, safeUrl };
