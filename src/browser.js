'use strict';
/** Locate an installed Chromium-family browser and build its command line. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const PF = process.env['ProgramFiles'] || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');

const CANDIDATES = {
  win32: [
    { id: 'chrome',  name: 'Google Chrome',  paths: [`${PF}\\Google\\Chrome\\Application\\chrome.exe`, `${PF86}\\Google\\Chrome\\Application\\chrome.exe`, `${LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`] },
    { id: 'brave',   name: 'Brave',          paths: [`${PF}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${PF86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`] },
    { id: 'edge',    name: 'Microsoft Edge', paths: [`${PF86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${PF}\\Microsoft\\Edge\\Application\\msedge.exe`] },
    { id: 'vivaldi', name: 'Vivaldi',        paths: [`${LOCALAPPDATA}\\Vivaldi\\Application\\vivaldi.exe`, `${PF}\\Vivaldi\\Application\\vivaldi.exe`] },
    { id: 'opera',   name: 'Opera',          paths: [`${LOCALAPPDATA}\\Programs\\Opera\\opera.exe`] },
    { id: 'chromium', name: 'Chromium',      paths: [`${LOCALAPPDATA}\\Chromium\\Application\\chrome.exe`] },
  ],
  darwin: [
    { id: 'chrome',  name: 'Google Chrome',  paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
    { id: 'brave',   name: 'Brave',          paths: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'] },
    { id: 'edge',    name: 'Microsoft Edge', paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
    { id: 'chromium', name: 'Chromium',      paths: ['/Applications/Chromium.app/Contents/MacOS/Chromium'] },
  ],
  linux: [
    { id: 'chrome',  name: 'Google Chrome',  paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/local/bin/google-chrome'] },
    { id: 'brave',   name: 'Brave',          paths: ['/usr/bin/brave-browser', '/usr/bin/brave', '/opt/brave.com/brave/brave-browser', '/snap/bin/brave', '/var/lib/flatpak/exports/bin/com.brave.Browser'] },
    { id: 'edge',    name: 'Microsoft Edge', paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'] },
    { id: 'vivaldi', name: 'Vivaldi',        paths: ['/usr/bin/vivaldi', '/usr/bin/vivaldi-stable', '/opt/vivaldi/vivaldi'] },
    { id: 'opera',   name: 'Opera',          paths: ['/usr/bin/opera', '/snap/bin/opera'] },
    { id: 'chromium', name: 'Chromium',      paths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/var/lib/flatpak/exports/bin/org.chromium.Chromium'] },
  ],
};

/**
 * Distributions disagree about where a browser lives, so PATH is consulted for
 * anything the fixed list missed. Cheaper than guessing at more directories,
 * and it picks up manual installs for free.
 */
const PATH_NAMES = {
  chrome: ['google-chrome', 'google-chrome-stable'],
  brave: ['brave-browser', 'brave'],
  edge: ['microsoft-edge', 'microsoft-edge-stable'],
  vivaldi: ['vivaldi', 'vivaldi-stable'],
  opera: ['opera'],
  chromium: ['chromium', 'chromium-browser'],
};

function findOnPath(names) {
  if (process.platform === 'win32') return null;
  const dirs = (process.env.PATH || '').split(':').filter(Boolean);
  for (const n of names) {
    for (const d of dirs) {
      const full = path.join(d, n);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return fs.realpathSync(full);
      } catch { /* next */ }
    }
  }
  return null;
}

function detectVersion(exePath) {
  // The Application directory contains a version-named subfolder; cheapest source.
  try {
    const dir = path.dirname(exePath);
    const versions = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => {
        const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
        for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
        return 0;
      });
    if (versions.length) return versions[0];
  } catch {}
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`,
      ], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
      if (/^\d+\./.test(out)) return out;
    } catch {}
  } else {
    try {
      const out = execFileSync(exePath, ['--version'], { encoding: 'utf8', timeout: 8000 }).trim();
      const m = out.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m) return m[1];
    } catch {}
  }
  return null;
}

/**
 * Browsers this tool downloaded itself, which live beside the project rather
 * than being installed on the machine.
 */
function listDownloaded(cfg) {
  try {
    // Required lazily: download.js pulls in config.js, which would otherwise
    // close a require cycle back through this module.
    const { findDownloaded } = require('./download');
    // Downloaded copies keep their own id (chrome / chromium / brave) so they
    // can be asked for by name, and are also reachable as "downloaded".
    return findDownloaded(cfg || {}).map((f) => ({
      id: f.id, name: f.label, path: f.path, downloaded: true, dir: f.dir,
    }));
  } catch { return []; }
}

function listBrowsers(cfg) {
  const list = CANDIDATES[process.platform] || CANDIDATES.linux;
  const found = [];
  for (const cand of list) {
    let hit = cand.paths.find((p) => fs.existsSync(p));
    if (!hit && PATH_NAMES[cand.id]) hit = findOnPath(PATH_NAMES[cand.id]);
    if (hit) found.push({ ...cand, path: hit });
  }
  // Installed browsers come first; a downloaded one is the fallback for a
  // machine that has none.
  return found.concat(listDownloaded(cfg));
}

/** @param {string} spec "auto", a browser id, or an absolute path to the binary. */
function findBrowser(spec, cfg) {
  const installed = listBrowsers(cfg);
  if (spec && spec !== 'auto') {
    if (fs.existsSync(spec)) {
      return { id: 'custom', name: path.basename(spec), path: spec, version: detectVersion(spec) };
    }
    const key = String(spec).toLowerCase();
    // "downloaded" means whichever browser this tool fetched.
    const hit = key === 'downloaded'
      ? installed.find((b) => b.downloaded)
      : installed.find((b) => b.id === key);
    if (!hit) {
      const names = installed.map((b) => b.id).join(', ') || '(none)';
      throw new Error(`Browser "${spec}" not found. Installed: ${names}`);
    }
    return { ...hit, version: detectVersion(hit.path) };
  }
  if (!installed.length) throw new Error('No Chromium-based browser detected. Point "browser" at an executable path in the config.');
  const best = installed[0];
  return { ...best, version: detectVersion(best.path) };
}

/**
 * Build the Chromium command line.
 * Order matters only for readability; Chromium does not care.
 */
function buildArgs({ cfg, identity, profile, debugPort, proxyUrl, geometry, bandwidthFlags }) {
  const p = cfg.privacy || {};
  const s = cfg.startup || {};
  const args = [];

  args.push(`--user-data-dir=${profile.dir}`);
  args.push(`--disk-cache-dir=${profile.cacheDir}`);
  args.push(`--remote-debugging-port=${debugPort}`);
  args.push('--no-first-run', '--no-default-browser-check', '--no-service-autorun');
  args.push('--disable-fre', '--propagate-iph-for-testing');

  // Keep the browser from phoning home on its own schedule.
  if (p.disableBackgroundNetworking !== false) {
    args.push(
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--no-pings',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-client-side-phishing-detection',
      '--safebrowsing-disable-auto-update',
      '--disable-search-engine-choice-screen',
    );
  }
  if (p.disableSync !== false) args.push('--disable-sync', '--disable-signin-promo');

  const disabledFeatures = [
    'Translate',
    'OptimizationHints',
    'MediaRouter',
    'InterestFeedContentSuggestions',
    'AutofillServerCommunication',
    'CalculateNativeWinOcclusion',
    'CertificateTransparencyComponentUpdater',
    'DialMediaRouteProvider',
  ];
  // AcceptCHFrame is how a server delivers client hints over HTTP/2. Turning it
  // off buys no privacy - the hints are sent either way - and it breaks the
  // negotiation some CDNs and challenge platforms rely on. It only appears in
  // this kind of list because automation frameworks disable it by default.
  if ((cfg.bandwidth || {}).allowChallenges === false) disabledFeatures.push('AcceptCHFrame');

  if (p.disablePrivacySandbox !== false) {
    disabledFeatures.push('PrivacySandboxSettings4', 'BrowsingTopics', 'InterestGroupStorage', 'Fledge', 'AttributionReporting');
    // Private State Tokens are the one Privacy Sandbox API that works for you
    // here: Cloudflare and hCaptcha use them to remember that this browser
    // already passed a check, without learning who it is. Off means every
    // visit starts from zero.
    if ((cfg.bandwidth || {}).allowChallenges === false) disabledFeatures.push('TrustTokens');
  }
  args.push(`--disable-features=${disabledFeatures.join(',')}`);

  // WebRTC can hand out the real LAN/public IP even behind a proxy.
  if ((cfg.network || {}).blockWebRTC !== false) {
    args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    args.push('--webrtc-ip-handling-policy=disable_non_proxied_udp');
  }

  if (proxyUrl) {
    args.push(`--proxy-server=${proxyUrl}`);
    // Chromium bypasses loopback by default and that is what we want: pushing
    // 127.0.0.1 through a proxy bound to a LAN address makes local dev servers
    // unreachable, and loopback traffic cannot leak onto the network anyway.
  }

  args.push(`--lang=${identity.locale}`);
  args.push(`--accept-lang=${identity.acceptLanguage}`);
  args.push(`--user-agent=${identity.userAgent}`);

  if (geometry) {
    // Multi-instance tiling dictates the geometry; it wins over config.
    args.push(`--window-size=${geometry.width},${geometry.height}`);
    args.push(`--window-position=${geometry.left},${geometry.top}`);
  } else if (s.windowSize === 'maximized') {
    args.push('--start-maximized');
  } else if (typeof s.windowSize === 'string' && /^\d+x\d+$/.test(s.windowSize)) {
    const [w, h] = s.windowSize.split('x');
    args.push(`--window-size=${w},${h}`);
  } else {
    args.push(`--window-size=${identity.window.width},${identity.window.height}`);
    args.push(`--window-position=${identity.window.left},${identity.window.top}`);
  }

  if (s.incognito) args.push('--incognito');

  const extensions = (cfg.extensions || []).filter((e) => fs.existsSync(e));
  if (extensions.length) args.push(`--load-extension=${extensions.join(',')}`);

  for (const flag of bandwidthFlags || []) args.push(flag);

  for (const flag of cfg.flags || []) args.push(flag);

  // Deferring the URLs means the browser starts with no window at all; the
  // launcher opens the tabs over DevTools once the overrides are armed, so the
  // first page never gets a chance to read an unspoofed value.
  if (s.deferUrls !== false) {
    args.push('--no-startup-window');
  } else {
    args.push('--new-window');
    args.push(...((s.urls && s.urls.length) ? s.urls : ['about:blank']));
  }
  return args;
}

module.exports = { findBrowser, listBrowsers, listDownloaded, detectVersion, buildArgs };
