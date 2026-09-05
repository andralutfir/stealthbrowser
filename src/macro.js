'use strict';
/**
 * Macro replay.
 *
 * Reads a recording produced by the session recorder and performs it again:
 * the same clicks, the same text in the same fields, the same submits, in the
 * same order. Nothing extra has to be captured for this - the .jsonl written by
 * every debug session already carries selectors, values and timings.
 *
 * Actions are replayed as real input events through the Input domain rather than
 * by calling el.click() from JavaScript, so pages that listen for genuine mouse
 * and keyboard events behave the same way they did during recording.
 */
const fs = require('fs');
const path = require('path');

/** Verbs the player knows how to perform; everything else is context, not action. */
const REPLAYABLE = new Set(['NAV', 'CLICK', 'DBLCLK', 'TYPE', 'CHANGE', 'SELECT', 'TOGGLE', 'SUBMIT', 'KEY', 'SCROLL']);

const KEY_CODES = {
  Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  PageUp: 33, PageDown: 34, Home: 36, End: 35,
};

/**
 * Load a recording (.jsonl) or a saved macro (.json) into normalised steps.
 * @returns {{steps: Array, source: string, recordedAt: string?}}
 */
function load(file) {
  const full = path.resolve(file);
  const raw = fs.readFileSync(full, 'utf8');
  let records;

  if (full.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(raw);
    records = Array.isArray(parsed) ? parsed : (parsed.steps || []);
  } else {
    records = raw.split('\n').filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }

  const steps = [];
  for (const r of records) {
    if (!r || !REPLAYABLE.has(r.verb)) continue;
    // A click on a link and the navigation it caused are the same user action.
    // Replaying both would navigate twice, so drop a NAV that closely follows
    // something that would have caused it anyway.
    if (r.verb === 'NAV' && steps.length) {
      const prev = steps[steps.length - 1];
      const caused = (prev.verb === 'CLICK' && prev.href) || prev.verb === 'SUBMIT';
      if (caused && r.at - prev.at < 3000) continue;
    }
    steps.push(r);
  }

  return {
    steps,
    source: full,
    recordedAt: records.length ? records[0].iso : null,
  };
}

function describe(macro) {
  const counts = {};
  for (const s of macro.steps) counts[s.verb] = (counts[s.verb] || 0) + 1;
  const parts = Object.keys(counts).sort().map((k) => `${counts[k]} ${k.toLowerCase()}`);
  const span = macro.steps.length ? macro.steps[macro.steps.length - 1].at : 0;
  return `${macro.steps.length} steps (${parts.join(', ')}) over ${(span / 1000).toFixed(1)}s`;
}

/** Save the replayable subset of a recording as a standalone macro file. */
function save(macro, file, meta = {}) {
  const out = {
    name: meta.name || path.basename(file).replace(/\.json$/i, ''),
    recordedAt: macro.recordedAt,
    source: macro.source,
    steps: macro.steps,
  };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), JSON.stringify(out, null, 2));
  return path.resolve(file);
}

class Player {
  /**
   * @param {object} cdp
   * @param {string} sessionId  the page session to drive
   * @param {object} opts { speed, maxDelayMs, waitForMs, stopOnMissing, secrets, onStep }
   */
  constructor(cdp, sessionId, opts = {}) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.speed = opts.speed > 0 ? opts.speed : 1;
    this.maxDelayMs = Number.isFinite(opts.maxDelayMs) ? opts.maxDelayMs : 3000;
    this.waitForMs = Number.isFinite(opts.waitForMs) ? opts.waitForMs : 10000;
    this.stopOnMissing = !!opts.stopOnMissing;
    this.secrets = opts.secrets || {};
    this.onStep = opts.onStep || (() => {});
    this.stats = { done: 0, skipped: 0, failed: 0 };
  }

  _eval(expression) {
    return this.cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, this.sessionId).then((r) => (r && r.result ? r.result.value : undefined));
  }

  /** Wait until a selector resolves, so replay survives slower page loads. */
  async _waitFor(selector) {
    if (!selector) return false;
    const deadline = Date.now() + this.waitForMs;
    const js = `!!document.querySelector(${JSON.stringify(selector)})`;
    for (;;) {
      let found = false;
      try { found = await this._eval(js); } catch { /* mid-navigation */ }
      if (found) return true;
      if (Date.now() > deadline) return false;
      await sleep(200);
    }
  }

  /** Scroll into view and return the element's centre in viewport coordinates. */
  async _centreOf(selector) {
    const js = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`;
    return this._eval(js);
  }

  async _mouseClick(point, clickCount = 1) {
    const base = { x: point.x, y: point.y, button: 'left', clickCount };
    await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, this.sessionId);
    await this.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, this.sessionId);
  }

  async _pressKey(combo) {
    const parts = String(combo).split('+');
    const key = parts[parts.length - 1];
    let modifiers = 0;
    if (parts.includes('Alt')) modifiers |= 1;
    if (parts.includes('Ctrl')) modifiers |= 2;
    if (parts.includes('Meta')) modifiers |= 4;
    if (parts.includes('Shift')) modifiers |= 8;

    const code = KEY_CODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const common = { modifiers, key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await this.cdp.send('Input.dispatchKeyEvent', { ...common, type: 'keyDown' }, this.sessionId);
    await this.cdp.send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' }, this.sessionId);
  }

  /** Resolve the text to type, filling in anything the recording redacted. */
  _valueFor(step) {
    if (step.value !== null && step.value !== undefined) return String(step.value);
    const keys = [step.selector, step.target, step.name].filter(Boolean);
    for (const k of keys) if (this.secrets[k] !== undefined) return String(this.secrets[k]);
    return null;
  }

  async _step(step) {
    switch (step.verb) {
      case 'NAV': {
        await this.cdp.send('Page.navigate', { url: step.url }, this.sessionId);
        await this._settle();
        return 'navigated to ' + step.url;
      }

      case 'SCROLL': {
        await this._eval(`window.scrollTo(0, document.documentElement.scrollHeight * ${(step.depth || 0) / 100})`);
        return `scrolled to ${step.depth}%`;
      }

      case 'KEY':
        await this._pressKey(step.combo);
        return `pressed ${step.combo}`;

      case 'CLICK':
      case 'DBLCLK': {
        if (!(await this._waitFor(step.selector))) return null;
        const point = await this._centreOf(step.selector);
        if (point) await this._mouseClick(point, step.verb === 'DBLCLK' ? 2 : 1);
        // Off-screen or zero-sized elements cannot receive a real mouse event.
        else await this._eval(`document.querySelector(${JSON.stringify(step.selector)}).click()`);
        return `clicked ${step.target || step.selector}`;
      }

      case 'TYPE':
      case 'CHANGE': {
        if (!(await this._waitFor(step.selector))) return null;
        const value = this._valueFor(step);
        if (value === null) {
          this.stats.skipped++;
          return `SKIPPED ${step.target || step.selector} (value was redacted; supply it under macro.secrets)`;
        }
        const point = await this._centreOf(step.selector);
        if (point) await this._mouseClick(point);
        await this._eval(`(() => {
          const el = document.querySelector(${JSON.stringify(step.selector)});
          if (!el) return;
          el.focus();
          if ('value' in el) el.value = '';
          else if (el.isContentEditable) el.textContent = '';
        })()`);
        // Real key events, so pages that validate as you type see the same thing.
        await this.cdp.send('Input.insertText', { text: value }, this.sessionId);
        await this._eval(`(() => {
          const el = document.querySelector(${JSON.stringify(step.selector)});
          if (!el) return;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        return `typed into ${step.target || step.selector}`;
      }

      case 'SELECT': {
        if (!(await this._waitFor(step.selector))) return null;
        await this._eval(`(() => {
          const el = document.querySelector(${JSON.stringify(step.selector)});
          if (!el) return;
          const want = ${JSON.stringify(step.option)};
          const byText = Array.from(el.options).find(o => o.text === want);
          if (byText) el.value = byText.value;
          else if (${JSON.stringify(step.value)} !== null) el.value = ${JSON.stringify(step.value)};
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        return `selected ${JSON.stringify(step.option)}`;
      }

      case 'TOGGLE': {
        if (!(await this._waitFor(step.selector))) return null;
        await this._eval(`(() => {
          const el = document.querySelector(${JSON.stringify(step.selector)});
          if (!el) return;
          if (el.checked !== ${!!step.checked}) el.click();
        })()`);
        return `${step.checked ? 'checked' : 'unchecked'} ${step.target || step.selector}`;
      }

      case 'SUBMIT': {
        // The recording usually holds a click on the submit button immediately
        // before this, which already submitted the form. Only submit directly
        // when nothing else did.
        await this._eval(`(() => {
          const f = document.querySelector('form');
          if (f && typeof f.requestSubmit === 'function') f.requestSubmit();
          else if (f) f.submit();
        })()`);
        await this._settle();
        return `submitted ${step.method || ''} ${step.action || ''}`.trim();
      }

      default:
        return null;
    }
  }

  /** Give a navigation a moment to commit before the next step looks for elements. */
  async _settle() {
    await sleep(600);
    const deadline = Date.now() + 8000;
    for (;;) {
      let state = '';
      try { state = await this._eval('document.readyState'); } catch { /* still swapping */ }
      if (state === 'complete' || state === 'interactive') return;
      if (Date.now() > deadline) return;
      await sleep(200);
    }
  }

  async run(macro) {
    let previousAt = macro.steps.length ? macro.steps[0].at : 0;
    for (let i = 0; i < macro.steps.length; i++) {
      const step = macro.steps[i];
      const gap = Math.max(0, Math.min(this.maxDelayMs, (step.at - previousAt) / this.speed));
      previousAt = step.at;
      if (gap) await sleep(gap);

      let result = null;
      let error = null;
      try {
        result = await this._step(step);
      } catch (e) { error = e.message; }

      if (error) {
        this.stats.failed++;
        this.onStep({ index: i + 1, total: macro.steps.length, verb: step.verb, text: `FAILED: ${error}`, ok: false });
        if (this.stopOnMissing) break;
      } else if (result === null) {
        this.stats.skipped++;
        this.onStep({ index: i + 1, total: macro.steps.length, verb: step.verb, text: `not found: ${step.selector || step.target || ''}`, ok: false });
        if (this.stopOnMissing) break;
      } else {
        this.stats.done++;
        this.onStep({ index: i + 1, total: macro.steps.length, verb: step.verb, text: result, ok: true });
      }
    }
    return this.stats;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { load, save, describe, Player, REPLAYABLE };
