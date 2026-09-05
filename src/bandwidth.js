'use strict';
/**
 * Bandwidth saving.
 *
 * The guiding rule is that a page must still work. So the default tier only
 * removes traffic a reader does not actually consume - ad and tracker payloads,
 * autoplaying video, streaming manifests - and asks servers for lighter assets
 * via Save-Data. Images, stylesheets and scripts are left alone, because that is
 * where "saving bandwidth" turns into "the site is broken".
 *
 * Blocking happens through Network.setBlockedURLs, which is enforced inside the
 * browser. Fetch-domain interception would give finer control but routes every
 * single request through Node and back, adding latency to page loads - the wrong
 * trade for a feature meant to make browsing lighter.
 */

/**
 * The heaviest ad, tracking and analytics endpoints by volume.
 * Deliberately not a full filter list: these few cover most of the wasted bytes
 * on a typical page without the false positives a 100k-rule list brings.
 */
const AD_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'googletagmanager.com',
  'googletagservices.com',
  'adservice.google.com',
  'amazon-adsystem.com',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'scorecardresearch.com',
  'quantserve.com',
  'moatads.com',
  'adsrvr.org',
  'casalemedia.com',
  'sharethrough.com',
  'teads.tv',
  'smartadserver.com',
  'yieldmo.com',
  'bidswitch.net',
  'facebook.net',
  'connect.facebook.net',
  'hotjar.com',
  'fullstory.com',
  'mouseflow.com',
  'clarity.ms',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'branch.io',
  'newrelic.com',
  'nr-data.net',
  'bugsnag.com',
  'sentry-cdn.com',
  'optimizely.com',
  'crazyegg.com',
  'inspectlet.com',
  'yandex.ru/metrika',
  'mc.yandex.ru',
];

/** Video and audio payloads, plus the manifests that pull them in. */
const MEDIA_PATTERNS = [
  '*.mp4*', '*.m4v*', '*.webm*', '*.mov*', '*.avi*', '*.mkv*', '*.flv*',
  '*.m3u8*', '*.mpd*', '*.f4m*',
  '*.mp3*', '*.m4a*', '*.aac*', '*.ogg*', '*.oga*', '*.opus*', '*.wav*', '*.flac*',
];

/** Web fonts. Strict tier only: icon fonts break visibly when these go. */
const FONT_PATTERNS = ['*.woff*', '*.woff2*', '*.ttf*', '*.otf*', '*.eot*'];

const PRESETS = {
  off: {
    blockAds: false, blockMedia: false, blockAutoplay: false,
    saveDataHeader: false, blockImages: false, blockFonts: false,
  },
  // Big savings, no visible breakage: this is the one to use day to day.
  balanced: {
    blockAds: true, blockMedia: true, blockAutoplay: true,
    saveDataHeader: true, blockImages: false, blockFonts: false,
  },
  // Text-first browsing. Pages stay readable and navigable, but lose their
  // pictures and icon fonts.
  strict: {
    blockAds: true, blockMedia: true, blockAutoplay: true,
    saveDataHeader: true, blockImages: true, blockFonts: true,
  },
};

/**
 * Merge the preset for `mode` with any explicit per-key overrides in the config.
 * An explicit true/false in config.json always wins over the preset.
 */
function resolve(cfg = {}) {
  const mode = PRESETS[cfg.mode] ? cfg.mode : 'off';
  const preset = PRESETS[mode];
  const out = { mode, enabled: mode !== 'off' };
  for (const key of Object.keys(preset)) {
    out[key] = typeof cfg[key] === 'boolean' ? cfg[key] : preset[key];
  }
  out.extraBlockPatterns = Array.isArray(cfg.extraBlockPatterns) ? cfg.extraBlockPatterns : [];
  // Captcha and bot-check frames keep everything they ask for. A challenge you
  // cannot see is a page you cannot use, and it is a one-off cost anyway.
  out.allowChallenges = cfg.allowChallenges !== false;
  out.report = cfg.report !== false;
  out.diskCacheMB = Number.isFinite(cfg.diskCacheMB) ? cfg.diskCacheMB : 256;
  // Any blocking at all still needs the Network domain turned on.
  out.needsNetworkDomain = out.enabled
    && (out.blockAds || out.blockMedia || out.blockFonts || out.extraBlockPatterns.length || out.report);
  return out;
}

/** URL patterns for Network.setBlockedURLs. */
function blockedUrls(bw) {
  if (!bw.enabled) return [];
  const urls = [];
  if (bw.blockAds) for (const h of AD_HOSTS) urls.push(`*${h}*`);
  if (bw.blockMedia) urls.push(...MEDIA_PATTERNS);
  if (bw.blockFonts) urls.push(...FONT_PATTERNS);
  urls.push(...bw.extraBlockPatterns);
  return urls;
}

/** Hostnames the local proxy should refuse, when one is running anyway. */
function blockedHosts(bw) {
  if (!bw.enabled || !bw.blockAds) return [];
  // Only bare hostnames; entries carrying a path are URL patterns, not hosts.
  return AD_HOSTS.filter((h) => !h.includes('/'));
}

/**
 * True when images are turned off through the profile's content settings
 * rather than the command line. The command-line switch is absolute and cannot
 * be relaxed for a single origin, so it is only used when nothing needs an
 * exception - otherwise a captcha's image challenge would be a blank grid.
 */
function imagesViaContentSettings(bw) {
  return !!(bw.enabled && bw.blockImages && bw.allowChallenges);
}

/** Extra Chromium command-line flags this mode wants. */
function browserFlags(bw) {
  if (!bw.enabled) return [];
  const flags = [];
  if (bw.blockAutoplay) flags.push('--autoplay-policy=user-gesture-required');
  // The absolute form: no request, no placeholder, and no way to make an
  // exception - which is why it is only used when nothing needs one.
  if (bw.blockImages && !imagesViaContentSettings(bw)) flags.push('--blink-settings=imagesEnabled=false');
  if (bw.diskCacheMB > 0) flags.push(`--disk-cache-size=${bw.diskCacheMB * 1024 * 1024}`);
  return flags;
}

/** Headers to add to every request. */
function extraHeaders(bw) {
  if (!bw.enabled || !bw.saveDataHeader) return null;
  // Widely honoured by CDNs and image pipelines, which then serve smaller
  // variants. Note it is also one more bit of entropy about this browser.
  return { 'Save-Data': 'on' };
}

function describe(bw) {
  if (!bw.enabled) return 'off';
  const on = [];
  if (bw.blockAds) on.push('ads/trackers');
  if (bw.blockMedia) on.push('media');
  if (bw.blockAutoplay) on.push('autoplay');
  if (bw.blockImages) on.push('images');
  if (bw.blockFonts) on.push('fonts');
  if (bw.saveDataHeader) on.push('Save-Data');
  const note = bw.allowChallenges ? '; captchas exempt' : '';
  return `${bw.mode} (${on.join(', ') || 'nothing'}${note})`;
}

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

/** Running totals for one session. */
class Meter {
  constructor() {
    this.bytes = 0;
    this.requests = 0;
    this.blocked = 0;
    this.fromCache = 0;
  }

  /** @param {object} params Network.loadingFinished params */
  finished(params) {
    this.requests++;
    this.bytes += params.encodedDataLength || 0;
  }

  failed(params) {
    if (params.blockedReason) this.blocked++;
  }

  cached() { this.fromCache++; }

  summary() {
    const parts = [`${formatBytes(this.bytes)} downloaded`, `${this.requests} requests`];
    if (this.blocked) parts.push(`${this.blocked} blocked`);
    if (this.fromCache) parts.push(`${this.fromCache} from cache`);
    return parts.join(', ');
  }
}

module.exports = {
  resolve, blockedUrls, blockedHosts, browserFlags, extraHeaders, describe,
  imagesViaContentSettings, formatBytes, Meter,
};
