'use strict';
/**
 * Page-level fingerprint patches.
 *
 * This is injected through Page.addScriptToEvaluateOnNewDocument, so it runs in
 * every frame in the main world *before* any page script. The payload is written
 * as a normal function and serialised with toString(), which keeps it readable
 * and avoids escaping a giant template literal.
 *
 * Division of labour: anything the DevTools Protocol can override at the browser
 * level (user agent, client hints, timezone, locale, geolocation) is done there
 * because it also fixes HTTP headers and worker contexts. This file only covers
 * what CDP cannot reach: JS-visible surfaces like screen metrics, WebGL strings,
 * and canvas/audio readback.
 */

/* eslint-disable no-undef */
function payload(CFG) {
  'use strict';
  if (window.__sbApplied) return;
  Object.defineProperty(window, '__sbApplied', { value: true, enumerable: false, configurable: false });

  // ---------------------------------------------------------------- utilities

  const nativeToString = Function.prototype.toString;
  const patched = new WeakMap();

  /** Make a replacement function report itself as native code. */
  function mask(fn, name) {
    patched.set(fn, `function ${name}() { [native code] }`);
    return fn;
  }

  const fakeToString = function toString() {
    const src = patched.get(this);
    return src !== undefined ? src : nativeToString.call(this);
  };
  patched.set(fakeToString, 'function toString() { [native code] }');
  Function.prototype.toString = fakeToString;

  function defineValue(target, prop, value) {
    if (!target) return;
    try {
      const getter = mask(function () { return value; }, `get ${prop}`);
      Object.defineProperty(target, prop, { get: getter, set: undefined, enumerable: true, configurable: true });
    } catch (_) { /* some props are locked down; skip rather than throw */ }
  }

  function replace(target, prop, factory) {
    if (!target || typeof target[prop] !== 'function') return;
    const original = target[prop];
    const next = factory(original);
    mask(next, prop);
    try { Object.defineProperty(target, prop, { value: next, writable: true, configurable: true }); } catch (_) {}
  }

  /** xorshift-ish deterministic hash: same inputs always give the same output. */
  function mix(seed, a, b) {
    let h = (seed ^ (a * 374761393) ^ (b * 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  // ------------------------------------------------------------------ webdriver

  defineValue(Navigator.prototype, 'webdriver', false);

  // ------------------------------------------------------------------ navigator

  if (CFG.hardware) {
    defineValue(Navigator.prototype, 'hardwareConcurrency', CFG.hardwareConcurrency);
    if ('deviceMemory' in Navigator.prototype || 'deviceMemory' in navigator) {
      defineValue(Navigator.prototype, 'deviceMemory', CFG.deviceMemory);
    }
    defineValue(Navigator.prototype, 'maxTouchPoints', CFG.maxTouchPoints);
  }

  if (CFG.locale) {
    defineValue(Navigator.prototype, 'language', CFG.languages[0]);
    defineValue(Navigator.prototype, 'languages', Object.freeze(CFG.languages.slice()));
  }

  if (CFG.userAgent) {
    defineValue(Navigator.prototype, 'platform', CFG.platform);
    defineValue(Navigator.prototype, 'userAgent', CFG.ua);
    defineValue(Navigator.prototype, 'appVersion', CFG.ua.replace(/^Mozilla\//, ''));
    defineValue(Navigator.prototype, 'vendor', 'Google Inc.');
    defineValue(Navigator.prototype, 'oscpu', undefined);
  }

  // ------------------------------------------------------------------- screen

  if (CFG.screenSpoof) {
    const s = CFG.screen;
    defineValue(Screen.prototype, 'width', s.width);
    defineValue(Screen.prototype, 'height', s.height);
    defineValue(Screen.prototype, 'availWidth', s.availWidth);
    defineValue(Screen.prototype, 'availHeight', s.availHeight);
    defineValue(Screen.prototype, 'availLeft', 0);
    defineValue(Screen.prototype, 'availTop', 0);
    defineValue(Screen.prototype, 'colorDepth', s.colorDepth);
    defineValue(Screen.prototype, 'pixelDepth', s.pixelDepth);
    defineValue(window, 'devicePixelRatio', s.dpr);

    // outerWidth/Height must stay >= innerWidth/Height or the numbers look forged.
    const chromeH = 88 + (s.dpr > 1 ? 8 : 0);
    defineValue(window, 'outerWidth', Math.min(s.availWidth, window.innerWidth || s.availWidth));
    defineValue(window, 'outerHeight', Math.min(s.availHeight, (window.innerHeight || s.availHeight) + chromeH));
    defineValue(window, 'screenX', 0);
    defineValue(window, 'screenY', 0);
    defineValue(window, 'screenLeft', 0);
    defineValue(window, 'screenTop', 0);
  }

  // -------------------------------------------------------------------- WebGL

  if (CFG.webglSpoof && CFG.webgl) {
    const UNMASKED_VENDOR = 0x9245;
    const UNMASKED_RENDERER = 0x9246;
    const VENDOR = 0x1f00;
    const RENDERER = 0x1f01;

    const patchGl = (proto) => {
      if (!proto) return;
      replace(proto, 'getParameter', (original) => function getParameter(param) {
        if (param === UNMASKED_VENDOR || param === VENDOR) return CFG.webgl.vendor;
        if (param === UNMASKED_RENDERER || param === RENDERER) return CFG.webgl.renderer;
        return original.apply(this, arguments);
      });
      // Reading back rendered pixels is another fingerprint; nudge it slightly.
      if (CFG.webglNoise) {
        replace(proto, 'readPixels', (original) => function readPixels(x, y, w, h, format, type, pixels) {
          const out = original.apply(this, arguments);
          if (pixels && pixels.length > 16) {
            const step = Math.max(4, (pixels.length / 512) | 0) & ~3;
            for (let i = 0; i < pixels.length; i += step) {
              const n = mix(CFG.noise.webgl, i, pixels.length) % 3;
              if (n === 0 && pixels[i] > 0 && pixels[i] < 255) pixels[i] = pixels[i] + 1;
            }
          }
          return out;
        });
      }
    };
    patchGl(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    patchGl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  }

  // ------------------------------------------------------------------- canvas

  if (CFG.canvasNoise) {
    const seed = CFG.noise.canvas;

    /** Perturb a sparse, content-dependent set of subpixels by +/-1. */
    const perturb = (data, width) => {
      const len = data.length;
      if (!len) return;
      // ~1 in 97 pixels: enough to change the hash, invisible to the eye.
      for (let i = 0; i < len; i += 4) {
        const px = (i >> 2) % width;
        const py = ((i >> 2) / width) | 0;
        const h = mix(seed, px, py);
        if (h % 97 !== 0) continue;
        // Alpha is in the rotation on purpose. A canvas that is mostly
        // transparent has RGB 0 everywhere, and PNG encoders discard the colour
        // of fully transparent pixels - touching only RGB would then leave the
        // encoded bytes identical for every seed.
        const channel = h % 4;
        const delta = (h >> 8) % 2 === 0 ? 1 : -1;
        const idx = i + channel;
        const v = data[idx] + delta;
        if (v >= 0 && v <= 255) data[idx] = v;
      }
    };

    replace(CanvasRenderingContext2D.prototype, 'getImageData', (original) => function getImageData(sx, sy, sw, sh) {
      const image = original.apply(this, arguments);
      try { perturb(image.data, image.width); } catch (_) {}
      return image;
    });

    const noisyCopy = (canvas) => {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx = copy.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      const image = ctx.getImageData(0, 0, copy.width, copy.height);
      ctx.putImageData(image, 0, 0);
      return copy;
    };

    replace(HTMLCanvasElement.prototype, 'toDataURL', (original) => function toDataURL() {
      try {
        if (this.width && this.height && this.width * this.height < 16777216) {
          return original.apply(noisyCopy(this), arguments);
        }
      } catch (_) {}
      return original.apply(this, arguments);
    });

    replace(HTMLCanvasElement.prototype, 'toBlob', (original) => function toBlob() {
      try {
        if (this.width && this.height && this.width * this.height < 16777216) {
          return original.apply(noisyCopy(this), arguments);
        }
      } catch (_) {}
      return original.apply(this, arguments);
    });

    if (window.OffscreenCanvas && OffscreenCanvas.prototype.convertToBlob) {
      replace(OffscreenCanvas.prototype, 'convertToBlob', (original) => function convertToBlob() {
        return original.apply(this, arguments);
      });
    }
  }

  // -------------------------------------------------------------------- audio

  if (CFG.audioNoise && window.AnalyserNode) {
    const seed = CFG.noise.audio;
    const jitter = (arr) => {
      for (let i = 0; i < arr.length; i += 1) {
        const h = mix(seed, i, arr.length);
        if (h % 23 !== 0) continue;
        arr[i] = arr[i] + ((h % 2 === 0 ? 1 : -1) * 1e-7 * (h % 100));
      }
    };
    replace(AnalyserNode.prototype, 'getFloatFrequencyData', (original) => function getFloatFrequencyData(array) {
      original.apply(this, arguments);
      try { jitter(array); } catch (_) {}
    });
    replace(AnalyserNode.prototype, 'getFloatTimeDomainData', (original) => function getFloatTimeDomainData(array) {
      original.apply(this, arguments);
      try { jitter(array); } catch (_) {}
    });
    if (window.AudioBuffer) {
      replace(AudioBuffer.prototype, 'getChannelData', (original) => function getChannelData() {
        const data = original.apply(this, arguments);
        try {
          for (let i = 0; i < data.length; i += 787) {
            const h = mix(seed, i, data.length);
            data[i] = data[i] + (h % 2 === 0 ? 1 : -1) * 1e-7;
          }
        } catch (_) {}
        return data;
      });
    }
  }

  // ----------------------------------------------------- font / rect metrics

  if (CFG.fontNoise) {
    const seed = CFG.noise.rects;
    const shift = (v, k) => v + ((mix(seed, Math.round(v * 100), k) % 7) - 3) / 1000;
    const patchRect = (rect, k) => {
      try {
        const out = { x: shift(rect.x, k), y: shift(rect.y, k), width: shift(rect.width, k + 1), height: shift(rect.height, k + 2) };
        return Object.assign(Object.create(DOMRect.prototype), {
          x: out.x, y: out.y, width: out.width, height: out.height,
          top: out.y, left: out.x, right: out.x + out.width, bottom: out.y + out.height,
        });
      } catch (_) { return rect; }
    };
    replace(Element.prototype, 'getBoundingClientRect', (original) => function getBoundingClientRect() {
      return patchRect(original.apply(this, arguments), this.tagName ? this.tagName.length : 0);
    });
    if (window.TextMetrics) {
      replace(CanvasRenderingContext2D.prototype, 'measureText', (original) => function measureText(text) {
        const m = original.apply(this, arguments);
        try {
          const w = m.width;
          defineValue(m, 'width', shift(w, String(text).length));
        } catch (_) {}
        return m;
      });
    }
  }

  // -------------------------------------------------------------- permissions

  // Real Chrome reports "denied" for notifications only when the user said so;
  // keep query() and Notification.permission from contradicting each other.
  if (window.Notification && navigator.permissions && navigator.permissions.query) {
    replace(navigator.permissions, 'query', (original) => function query(desc) {
      if (desc && desc.name === 'notifications') {
        return Promise.resolve({
          state: Notification.permission,
          name: 'notifications',
          onchange: null,
          addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
        });
      }
      return original.apply(this, arguments);
    });
  }

  // ---------------------------------------------------------- client hints JS

  // CDP already sets navigator.userAgentData; this is the fallback path for when
  // the DevTools connection is disabled in config.
  if (CFG.userAgent && CFG.uaDataFallback && navigator.userAgentData === undefined && window.NavigatorUAData === undefined) {
    const brands = CFG.brands;
    const highEntropy = {
      architecture: CFG.architecture,
      bitness: CFG.bitness,
      brands,
      fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === 'Chromium' || b.brand === 'Google Chrome' ? CFG.fullVersion : b.version })),
      mobile: false,
      model: CFG.model,
      platform: CFG.chPlatform,
      platformVersion: CFG.platformVersion,
      uaFullVersion: CFG.fullVersion,
      wow64: false,
    };
    defineValue(Navigator.prototype, 'userAgentData', {
      brands: Object.freeze(brands.slice()),
      mobile: false,
      platform: CFG.chPlatform,
      getHighEntropyValues: mask(function getHighEntropyValues(hints) {
        const out = { brands: highEntropy.brands, mobile: false, platform: highEntropy.platform };
        for (const h of hints || []) if (h in highEntropy) out[h] = highEntropy[h];
        return Promise.resolve(out);
      }, 'getHighEntropyValues'),
      toJSON: mask(function toJSON() { return { brands, mobile: false, platform: CFG.chPlatform }; }, 'toJSON'),
    });
  }
}
/* eslint-enable no-undef */

/**
 * @param {object} identity persona from identity.js
 * @param {object} spoof    identity.spoof section of the config
 * @returns {string} script to hand to Page.addScriptToEvaluateOnNewDocument
 */
function buildInjectScript(identity, spoof = {}, extra = {}) {
  const cfg = {
    ua: identity.userAgent,
    fullVersion: identity.browserVersion,
    platform: identity.platform,
    chPlatform: identity.chPlatform,
    platformVersion: identity.platformVersion,
    architecture: identity.architecture,
    bitness: identity.bitness,
    model: identity.model,
    brands: identity.brands,
    languages: identity.languages,
    screen: identity.screen,
    hardwareConcurrency: identity.hardwareConcurrency,
    deviceMemory: identity.deviceMemory,
    maxTouchPoints: identity.maxTouchPoints,
    webgl: identity.webgl,
    noise: identity.noise,

    userAgent: spoof.userAgent !== false,
    locale: spoof.locale !== false,
    hardware: spoof.hardware !== false,
    screenSpoof: spoof.screen !== false,
    webglSpoof: spoof.webgl !== false,
    webglNoise: spoof.webglNoise !== false,
    canvasNoise: spoof.canvasNoise !== false,
    audioNoise: spoof.audioNoise !== false,
    fontNoise: spoof.fontNoise === true,
    uaDataFallback: spoof.uaDataFallback === true,
  };
  return `(${payload.toString()})(${JSON.stringify(cfg)});`;
}

module.exports = { buildInjectScript };
