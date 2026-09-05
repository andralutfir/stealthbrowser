'use strict';
/**
 * Throwaway browser profile.
 *
 * Every launch gets its own user-data-dir under the OS temp folder, pre-seeded
 * with privacy preferences so the very first request already behaves, and wiped
 * on exit. Nothing ever lands in the user's real Chrome profile.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bandwidth = require('./bandwidth');
const challenge = require('./challenge');

/**
 * Chromium stamps every content-setting exception with a Windows FILETIME. Any
 * plausible value works; the browser only compares them against each other.
 */
function settingStamp() {
  return String((Date.now() + 11644473600000) * 1000);
}

/**
 * Build a content-settings exception table that allows `patterns`.
 * @param {string[]} patterns primary patterns, e.g. "[*.]hcaptcha.com"
 * @param {string} secondary  the embedding context, "*" for any
 */
function allowExceptions(patterns, secondary = '*') {
  const out = {};
  for (const p of patterns) out[`${p},${secondary}`] = { last_modified: settingStamp(), setting: 1 };
  return out;
}

/** Preferences Chromium reads at startup; equivalent to toggling them in Settings. */
function buildPreferences(cfg, identity) {
  const p = cfg.privacy || {};
  const bw = bandwidth.resolve(cfg.bandwidth || {});

  // Images off through content settings rather than the command line, so the
  // captcha providers below can keep theirs. Without that a challenge grid is
  // just empty boxes and the page becomes impossible to get past.
  const exceptions = {};
  // Deny by default for the APIs that most cheaply de-anonymise a visitor.
  // Chromium reads these under "profile.", so that is where they have to live.
  const contentDefaults = {
    geolocation: p.blockGeolocation === false ? 1 : 2,
    notifications: 2,
    media_stream_mic: 2,
    media_stream_camera: 2,
    midi_sysex: 2,
    usb_chooser_data: 2,
    serial_guard: 2,
    bluetooth_guard: 2,
    clipboard: 2,
    payment_handler: 2,
    idle_detection: 2,
    sensors: p.blockSensors === false ? 1 : 2,
  };
  if (bandwidth.imagesViaContentSettings(bw)) {
    contentDefaults.images = 2;
    exceptions.images = allowExceptions(challenge.ORIGIN_PATTERNS);
  }
  if (bw.allowChallenges && p.blockThirdPartyCookies !== false) {
    // A challenge iframe that cannot reach its own storage falls back to a
    // harder puzzle, or refuses outright ("requestStorageAccess: Permission
    // denied"). These grants are scoped to the providers and nothing else.
    exceptions.cookies = allowExceptions(challenge.ORIGIN_PATTERNS);
    exceptions.storage_access = allowExceptions(challenge.ORIGIN_PATTERNS);
  }

  const prefs = {
    profile: {
      name: 'Stealth',
      exit_type: 'Normal',
      exited_cleanly: true,
      password_manager_enabled: false,
      default_content_setting_values: contentDefaults,
      content_settings: { exceptions },
      block_third_party_cookies: p.blockThirdPartyCookies !== false,
    },
    // 0 = allow all, 1 = block third-party, 2 = block third-party in incognito, 4 = block all
    profile_block_third_party_cookies: p.blockThirdPartyCookies !== false,
    enable_do_not_track: p.doNotTrack !== false,
    credentials_enable_service: false,
    credentials_enable_autosignin: false,
    autofill: { credit_card_enabled: false, profile_enabled: false },
    translate: { enabled: false },
    search: { suggest_enabled: false },
    alternate_error_pages: { enabled: false },
    dns_prefetching: { enabled: false },
    net: { network_prediction_options: 2 },
    safebrowsing: {
      enabled: p.safeBrowsing === true,
      enhanced: false,
      scout_reporting_enabled: false,
    },
    signin: { allowed: false, allowed_on_next_startup: false },
    sync: { requested: false },
    webrtc: {
      ip_handling_policy: (cfg.network || {}).blockWebRTC !== false ? 'disable_non_proxied_udp' : 'default',
      multiple_routes_enabled: false,
      nonproxied_udp_enabled: false,
    },
    intl: {
      accept_languages: identity.acceptLanguage,
      selected_languages: identity.languages.join(','),
    },
    browser: {
      has_seen_welcome_page: true,
      check_default_browser: false,
      show_home_button: false,
      clear_data: { browsing_history: true, cache: true, cookies: true, passwords: true, form_data: true },
    },
    bookmark_bar: { show_on_all_tabs: false },
    // Brave's new tab page is a live dashboard: sponsored background images,
    // Brave News, rewards and stats widgets, all of which fetch on load. Strip
    // it to nothing - it is network chatter this browser exists to avoid, and a
    // lighter page is also far less likely to fall over when the tab is being
    // instrumented. Chromium ignores these keys.
    brave: {
      new_tab_page: {
        // Brave's own "New tab page shows" setting: 0 dashboard, 1 homepage,
        // 2 blank. Blank means the dashboard is never constructed at all, which
        // is what actually stops it crashing under instrumentation - a redirect
        // issued after the fact is always racing it.
        shows_options: 2,
        show_background_image: false,
        show_branded_background_image: false,
        show_brave_news: false,
        show_rewards: false,
        show_together: false,
        show_stats: false,
        show_clock: false,
        hide_all_widgets: true,
      },
      today: { should_show_toolbar_button: false, opted_in: false },
      stats_reporting_enabled: false,
      p3a: { enabled: false },
      rewards: { show_brave_rewards_button_in_location_bar: false },
    },
    privacy_sandbox: {
      m1: { consent_decision_made: true, eea_notice_acknowledged: true, restricted_notice_acknowledged: true, ad_measurement_enabled: false, fledge_enabled: false, topics_enabled: false },
      apis_enabled_v2: false,
      first_party_sets_enabled: false,
    },
  };
  return prefs;
}

function buildLocalState(identity) {
  return {
    browser: { enabled_labs_experiments: [] },
    // Stops the "restore pages?" bubble from a previous unclean exit.
    profile: { info_cache: {}, last_used: 'Default' },
    intl: { accept_languages: identity.acceptLanguage, app_locale: identity.locale },
    user_experience_metrics: { reporting_enabled: false },
    variations_country: identity.locale.split('-')[1] || 'US',
  };
}

function createProfile(cfg, identity) {
  const root = (cfg.privacy && cfg.privacy.profileRoot) || os.tmpdir();
  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(root, `stealthbrowser-${Date.now().toString(36)}-${id}`);
  const defaultDir = path.join(dir, 'Default');
  const cacheDir = path.join(dir, 'Cache');

  fs.mkdirSync(defaultDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'First Run'), '');
  fs.writeFileSync(path.join(defaultDir, 'Preferences'), JSON.stringify(buildPreferences(cfg, identity)));
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify(buildLocalState(identity)));

  return { dir, defaultDir, cacheDir, id, ephemeral: (cfg.privacy || {}).wipeOnExit !== false };
}

/**
 * Windows keeps profile files locked for a moment after the browser exits, so
 * retry a few times before giving up.
 */
async function wipeProfile(profile, { attempts = 12, delayMs = 400, verbose = false } = {}) {
  if (!profile || !profile.dir) return true;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(profile.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (!fs.existsSync(profile.dir)) return true;
    } catch (e) {
      if (verbose) console.log(`[profile] delete attempt ${i + 1} failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return !fs.existsSync(profile.dir);
}

/** Remove leftovers from previous runs that crashed before cleanup. */
function sweepOrphans(cfg) {
  const root = (cfg.privacy && cfg.privacy.profileRoot) || os.tmpdir();
  let removed = 0;
  try {
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith('stealthbrowser-')) continue;
      const full = path.join(root, name);
      try {
        const age = Date.now() - fs.statSync(full).mtimeMs;
        if (age < 60000) continue; // could belong to a running instance
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch {}
    }
  } catch {}
  return removed;
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch {} }
    }
  };
  walk(dir);
  return total;
}

module.exports = { createProfile, wipeProfile, sweepOrphans, dirSize };
