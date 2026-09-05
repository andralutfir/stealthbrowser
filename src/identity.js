'use strict';
/**
 * Builds one coherent, seeded identity ("persona") per launch.
 * Everything downstream (CDP overrides, injected patches, proxy headers) reads
 * from this single object so the values can never contradict each other.
 */
const os = require('os');
const { makeRng, newSeed, hash32 } = require('./rng');
const P = require('./personas');

const OS_TOKENS = {
  windows: { ua: 'Windows NT 10.0; Win64; x64', platform: 'Win32', chPlatform: 'Windows', versions: P.WIN_PLATFORM_VERSIONS, oscpu: 'Windows' },
  macos:   { ua: 'Macintosh; Intel Mac OS X 10_15_7', platform: 'MacIntel', chPlatform: 'macOS', versions: P.MAC_PLATFORM_VERSIONS, oscpu: 'macOS' },
  linux:   { ua: 'X11; Linux x86_64', platform: 'Linux x86_64', chPlatform: 'Linux', versions: P.LINUX_PLATFORM_VERSIONS, oscpu: 'Linux' },
};

function hostPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

/**
 * Drift the browser's real build/patch numbers a little. The major version is
 * kept truthful: claiming a major the engine does not match is trivially caught
 * by feature detection.
 */
function driftVersion(realVersion, rng, drift) {
  const parts = String(realVersion || '0.0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 4) parts.push(0);
  if (!drift) return parts.join('.');
  const build = Math.max(0, parts[2] + rng.int(-40, 40));
  const patch = Math.max(0, rng.int(0, 180));
  return [parts[0], parts[1], build, patch].join('.');
}

function buildUserAgent(osKey, fullVersion) {
  const t = OS_TOKENS[osKey];
  const major = fullVersion.split('.')[0];
  return `Mozilla/5.0 (${t.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Chrome's GREASE brand list: one fake brand + Chromium + the branded name. */
function buildBrands(major, rng) {
  const greaseChars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const a = rng.pick(greaseChars), b = rng.pick(greaseChars);
  const greaseVersion = rng.pick(['8', '24', '99']);
  const brands = [
    { brand: `Not${a}A${b}Brand`, version: greaseVersion },
    { brand: 'Chromium', version: String(major) },
    { brand: 'Google Chrome', version: String(major) },
  ];
  // Chrome shuffles the order on every launch; mirror that.
  for (let i = brands.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [brands[i], brands[j]] = [brands[j], brands[i]];
  }
  return brands;
}

/**
 * @param {object}  cfg    resolved config
 * @param {object}  binary { version } of the browser we are launching
 * @param {object?} opts   { minWindow: {width, height} } - when the real window
 *                         geometry is dictated from outside (tiled multi-window
 *                         mode), the spoofed screen must still be able to
 *                         contain it, or innerWidth ends up larger than
 *                         screen.width and the whole persona reads as forged.
 */
function createIdentity(cfg, binary, opts = {}) {
  const id = cfg.identity || {};
  const seed = id.seed || newSeed();
  const rng = makeRng(seed);

  const osKey = !id.platform || id.platform === 'auto' ? hostPlatform() : id.platform;
  const osToken = OS_TOKENS[osKey] || OS_TOKENS.windows;

  // Locale bundle, optionally restricted by config.
  let pool = P.LOCALES;
  if (Array.isArray(id.locales) && id.locales.length) {
    const wanted = id.locales.map((l) => l.toLowerCase());
    const filtered = P.LOCALES.filter((l) => wanted.includes(l.locale.toLowerCase()));
    if (filtered.length) pool = filtered;
  }
  const loc = rng.pick(pool);
  const timezone = id.timezone && id.timezone !== 'random' ? id.timezone : loc.tz;

  const fullVersion = driftVersion(binary.version, rng, id.driftVersion !== false);
  const major = parseInt(fullVersion.split('.')[0], 10);
  const userAgent = id.userAgent && id.userAgent !== 'random'
    ? id.userAgent
    : buildUserAgent(osKey, fullVersion);

  const min = opts.minWindow || null;
  let screenPool = P.SCREENS;
  if (min) {
    const fits = P.SCREENS.filter((s) => s.w >= min.width && s.h - s.taskbar >= min.height);
    if (fits.length) screenPool = fits;
    else screenPool = [P.SCREENS.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b))];
  }
  const screen = rng.pick(screenPool);

  // Inner viewport: a plausible window inside that screen, never larger than it.
  let winW = Math.min(screen.w - rng.int(0, 220), rng.int(1024, 1600));
  let winH = Math.min(screen.h - screen.taskbar - rng.int(0, 160), rng.int(700, 1000));
  if (min) { winW = min.width; winH = min.height; }

  const gpu = rng.pick(P.GPUS[osKey] || P.GPUS.windows);

  return {
    seed,
    os: osKey,
    platform: osToken.platform,
    userAgent,
    browserVersion: fullVersion,
    browserMajor: major,
    brands: buildBrands(major, rng),
    platformVersion: rng.pick(osToken.versions),
    chPlatform: osToken.chPlatform,
    architecture: 'x86',
    bitness: '64',
    model: '',
    locale: loc.locale,
    languages: loc.languages,
    acceptLanguage: loc.acceptLanguage,
    timezone,
    geo: { latitude: loc.geo[0] + rng.float(-0.08, 0.08, 5), longitude: loc.geo[1] + rng.float(-0.08, 0.08, 5), accuracy: rng.int(20, 140) },
    screen: {
      width: screen.w,
      height: screen.h,
      availWidth: screen.w,
      availHeight: screen.h - screen.taskbar,
      colorDepth: 24,
      pixelDepth: 24,
      dpr: screen.dpr,
    },
    window: { width: winW, height: winH, left: rng.int(0, Math.max(0, screen.w - winW)), top: rng.int(0, Math.max(0, screen.h - winH - screen.taskbar)) },
    hardwareConcurrency: rng.pick(P.CORES),
    deviceMemory: rng.pick(P.MEMORY),
    maxTouchPoints: 0,
    webgl: gpu,
    // Stable per-session noise keys: the same input always yields the same output
    // within a session (a value that changes per call is itself a fingerprint).
    noise: {
      canvas: hash32(seed + ':canvas'),
      webgl: hash32(seed + ':webgl'),
      audio: hash32(seed + ':audio'),
      rects: hash32(seed + ':rects'),
      fonts: hash32(seed + ':fonts'),
    },
    hostPlatform: hostPlatform(),
    hostname: os.hostname(),
  };
}

function describeIdentity(p) {
  return [
    `  seed         : ${p.seed}`,
    `  user-agent   : ${p.userAgent}`,
    `  platform     : ${p.chPlatform} ${p.platformVersion} (${p.platform})`,
    `  locale / tz  : ${p.locale} [${p.languages.join(', ')}] / ${p.timezone}`,
    `  screen       : ${p.screen.width}x${p.screen.height} @${p.screen.dpr}x  window ${p.window.width}x${p.window.height}`,
    `  hardware     : ${p.hardwareConcurrency} cores / ${p.deviceMemory} GB`,
    `  gpu          : ${p.webgl.renderer}`,
    `  geolocation  : ${p.geo.latitude.toFixed(3)}, ${p.geo.longitude.toFixed(3)}`,
  ].join('\n');
}

module.exports = { createIdentity, describeIdentity, hostPlatform };
