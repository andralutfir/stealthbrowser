'use strict';
/** Config defaults, file loading, deep merge and CLI overrides. */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // "auto" picks the first installed browser, or set: chrome | brave | edge |
  // vivaldi | opera | chromium | an absolute path to the executable.
  browser: 'auto',

  // Fetch a browser when the machine has none. Uses Chrome for Testing:
  // Google's own versioned builds, shipped as a plain ZIP - nothing is
  // installed, no administrator rights, no system settings touched.
  downloadBrowser: {
    // Download automatically the first time no browser can be found.
    auto: true,
    // "Stable" | "Beta" | "Dev" | "Canary"
    channel: 'Stable',
    // Where the browser lands; relative paths sit next to the project.
    dir: 'browsers',
  },

  startup: {
    urls: ['https://google.com'],
    // "random" | "maximized" | "1280x800"
    windowSize: 'random',
    incognito: true,
    // Where Ctrl+T goes. The browsers' built-in new tab pages are live
    // network-backed dashboards - Brave's fetches sponsored images and Brave
    // News, Chrome's talks to Google - so a disposable browser is better off
    // without them. Brave additionally crashes when its new tab page loads
    // under an attached debugger, which this avoids.
    // Set to null to keep the browser's own new tab page.
    newTabUrl: 'about:blank',

    // Open the startup URLs through DevTools after the spoofing is armed.
    // Turning this off puts them on the command line, which is marginally
    // faster but lets the first page load before the overrides land.
    deferUrls: true,
  },

  identity: {
    randomize: true,
    // null = a brand-new persona each launch; any string = reproducible persona.
    seed: null,
    // "auto" keeps the host OS. Claiming another OS is far easier to detect.
    platform: 'auto',
    // Restrict the locale pool, e.g. ["en-US", "id-ID"]. Empty = all.
    locales: [],
    // "random" or an IANA zone like "Asia/Jakarta".
    timezone: 'random',
    // "random" or a literal UA string.
    userAgent: 'random',
    driftVersion: true,
    spoof: {
      userAgent: true,
      locale: true,
      timezone: true,
      geolocation: true,
      screen: true,
      hardware: true,
      webgl: true,
      webglNoise: true,
      canvasNoise: true,
      audioNoise: true,
      // Off by default: sub-pixel rect noise can visibly break some layouts.
      fontNoise: false,
      uaDataFallback: false,
    },
  },

  // How many browsers to open at once, and how to arrange them on screen.
  // Identities are never shared between instances - only the geometry is.
  instances: {
    count: 1,
    // "tile" splits the monitor into tall columns, "cascade" offsets each
    // window by a step, "none" lets every persona pick its own window size.
    layout: 'tile',
    // Force a column count; null derives it from `count`.
    columns: null,
    // Wrap into a second row past this many windows in one row.
    maxPerRow: 6,
    // Pixels between tiles.
    gap: 0,
    // Override monitor detection: { "width": 2560, "height": 1400 }
    monitor: null,
    // Delay between launches so several cold starts do not fight for the disk.
    staggerMs: 700,
  },

  // Local status page opened as the first tab of every session: the identity in
  // use, what websites actually see, and the current public IP. The configured
  // startup URLs still open right after it.
  statusPage: {
    enabled: false,
    // Which view the page opens in: "simple" reads as sentences and flags only
    // what needs attention; "advanced" is the full side-by-side check. Both are
    // one click apart on the page itself, this only picks the starting one.
    mode: 'advanced',
    // "system" follows the OS light/dark setting; "light" and "dark" pin it.
    theme: 'system',
    // Looked up from inside the browser, so it travels this session's own path.
    checkIp: true,
    // Must return JSON and allow CORS. The default also reports city/country/ISP.
    ipService: 'https://ipinfo.io/json',
    // Used when the primary service fails or rate-limits.
    ipFallback: 'https://api.ipify.org?format=json',

    // Score the address a site would see: residential or datacenter, flagged
    // as a proxy or not, and whether its timezone agrees with the browser's.
    // Every deduction is shown with its weight, so the number can be checked.
    checkQuality: true,
    // Free and keyless. Plain HTTP is what that tier serves; the status page is
    // local HTTP too, so nothing is downgraded. Point this at another service
    // that reports proxy/hosting/mobile under the same names to use it instead.
    qualityService: 'http://ip-api.com/json/?fields=status,message,country,countryCode,city,timezone,isp,org,as,reverse,mobile,proxy,hosting,query',
  },

  // Read and written by the control panel (node src/index.js --app) only.
  // "simple" opens the one-page view, "advanced" the full settings surface.
  gui: {
    mode: 'advanced',
    // "system" follows the OS setting; "light" and "dark" pin it.
    theme: 'system',
  },

  // Bandwidth saving. "balanced" is the one meant for daily use: it removes
  // traffic you never actually look at, and leaves the page intact.
  bandwidth: {
    // "off" | "balanced" | "strict"
    //   balanced -> block ads/trackers + video/audio payloads, stop autoplay,
    //               ask servers for lighter assets (Save-Data). Nothing breaks.
    //   strict   -> also drop images and web fonts. Readable, but plain.
    mode: 'off',

    // Any of these overrides the preset for the chosen mode.
    blockAds: null,
    blockMedia: null,
    blockAutoplay: null,
    blockImages: null,
    blockFonts: null,
    saveDataHeader: null,

    // Extra URL patterns to block, e.g. ["*.gif*", "*cdn.example.com*"].
    extraBlockPatterns: [],

    // Leave captcha and bot-check frames alone: hCaptcha, reCAPTCHA, Turnstile,
    // Arkose, GeeTest, DataDome and friends keep their images, fonts and audio
    // challenge. Without this, strict mode turns a puzzle grid into empty boxes
    // and there is no way past the page. Costs a few hundred KB, once.
    allowChallenges: true,

    // In-session HTTP cache size. The profile is disposable, so this only helps
    // within one session - but that is where most re-downloads happen.
    diskCacheMB: 256,

    // Print a usage summary when the session ends.
    report: true,
  },

  // Macro replay. Point `file` at a recording (.jsonl from any debug session)
  // or a saved macro (.json) and the session performs it again: same clicks,
  // same text in the same fields, same submits, in the same order.
  macro: {
    file: null,
    // 1 = original pacing, 2 = twice as fast, 0.5 = half speed.
    speed: 1,
    // Cap on the wait between steps, so a long pause while recording does not
    // become a long pause on replay.
    maxDelayMs: 3000,
    // How long to wait for an element to turn up before giving up on a step.
    waitForMs: 10000,
    // Stop at the first step that cannot be performed, instead of carrying on.
    stopOnMissing: false,
    // Values for fields the recording redacted, keyed by selector or by the
    // field description shown in the log, e.g. { "#pw": "hunter2" }.
    secrets: {},
  },

  // Mirror what happens in the browser to the console and a log file.
  // Values are never recorded - no typed text, no cookies, no request bodies.
  debug: {
    enabled: false,
    // null = auto-name inside logDir
    logFile: null,
    logDir: 'logs',
    // error | warn | info | debug   ("debug" includes every network request)
    level: 'info',
    // Also print log lines to the terminal.
    console: true,
    captureConsole: true,   // page console.log / warn / error
    network: true,          // requests, responses, failures
    browserLogs: true,      // CSP, mixed content, deprecations
    interactions: true,     // the session recorder: clicks, typing, forms, keys

    // Record what was actually typed into each field, not just which field.
    captureValues: true,
    // Password and credential-shaped fields stay masked even so. Turning this
    // off writes real passwords into a plain-text file on disk.
    redactSecrets: true,
    maxValueLength: 200,
    // Wait this long after the last keystroke before recording a field's value,
    // so typing produces one entry instead of one per character.
    typeIdleMs: 900,

    captureKeys: true,      // named keys and shortcuts only, never plain characters
    captureScroll: true,    // 25/50/75/100% depth milestones

    jsonl: true,            // structured sidecar next to the .log
    htmlReport: true,       // browsable timeline written when the session ends
  },

  network: {
    // "auto" | "wifi" | "lan" | "ethernet" | "vpn" | interface name | source IP
    interface: 'wifi',
    // "http://user:pass@host:port" or "socks5://user:pass@host:port"
    proxy: null,
    // One proxy per instance in multi mode; cycles if there are fewer than
    // instances. Overrides `proxy` when non-empty.
    proxies: [],
    // Custom resolvers for the local proxy, e.g. ["1.1.1.1", "9.9.9.9"].
    dnsServers: [],
    blockWebRTC: true,
    // Hostname suffixes refused by the local proxy (only active when the proxy runs).
    blockHosts: [],
  },

  privacy: {
    // A fresh user-data-dir per launch, removed on exit.
    wipeOnExit: true,
    // Where the throwaway profiles live. null = OS temp folder.
    profileRoot: null,
    disableSync: true,
    disableBackgroundNetworking: true,
    disablePrivacySandbox: true,
    blockThirdPartyCookies: true,
    doNotTrack: true,
    blockGeolocation: true,
    blockSensors: true,
    // Google Safe Browsing sends URL hashes upstream; off by default here.
    safeBrowsing: false,
  },

  // Absolute paths to unpacked extension directories.
  extensions: [],
  // Extra raw Chromium flags, e.g. ["--force-dark-mode"].
  flags: [],

  verbose: false,
};

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (isObject(v) && isObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function stripJsonComments(text) {
  // Tolerate // and /* */ comments so config.json can document itself.
  let out = '';
  let inString = false, inLine = false, inBlock = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

function loadFile(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(stripJsonComments(raw));
  } catch (e) {
    throw new Error(`Invalid config (${file}): ${e.message}`);
  }
}

const HELP = `
stealthbrowser - disposable browser: a fresh profile and identity on every launch

  node src/index.js [options] [url...]

Options:
  --config <file>        Use a different config file (default: config.json)
  --url <url>            Startup URL (repeatable; overrides the config)
  --browser <id|path>    chrome | brave | edge | vivaldi | opera | chromium | path to .exe
  --interface <spec>     auto | wifi | lan | vpn | interface name | source IP
  --proxy <url>          http(s)://... or socks5://user:pass@host:port
                         (repeatable: one proxy per instance, cycled)
  --seed <string>        Reproduce an exact persona
  --window <spec>        random | maximized | 1280x800
  --status / --no-status Show (or hide) the identity + IP status tab
  --bandwidth <mode>     off | balanced | strict  (data saving)
  --replay <file>        Replay a recording or saved macro in this session
  --speed <n>            Replay pacing (1 = as recorded, 2 = twice as fast)
  --incognito            Add incognito on top of the disposable profile
  --keep-profile         Keep the profile on exit (for debugging)
  --no-spoof             Turn off all identity spoofing
  --verbose              Launcher internals (proxy, CDP, cleanup)

Multiple browsers:
  --count <n>, -n <n>    Open n browsers at once, each with its own identity
  --layout <mode>        tile (tall columns) | cascade | none
  --columns <n>          Force the column count when tiling
  --gap <px>             Space between windows

Debug:
  --debug                Log browser activity to the console + a log file
  --no-debug             Turn logging off for this run, whatever the config says
  --log-file <file>      Write the log to a specific file
  --log-level <level>    error | warn | info | debug
  --no-log-console       Log to file only, not to the terminal

Commands:
  --list-interfaces      Show usable network interfaces
  --list-browsers        Show detected browsers, and what can be downloaded
  --install-browser [b]   Download a browser: chrome | chromium | brave
                         optionally a channel: --install-browser chrome Beta
  --no-download          Never fetch a browser automatically
  --print-identity       Print the persona without opening a browser
  --print-config         Print the effective config and which file was read
  --dump-config          Same, as raw JSON (used by the GUI)
  --init-config          Rewrite config.json from config.example.json
  --app                  Open the control panel window (settings + launcher)
  --check                Run a setup health check
  --help                 Show this help
`.trim();

function parseArgs(argv) {
  const out = { urls: [], proxies: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    switch (a) {
      case '--config': out.config = take(); break;
      case '--url': out.urls.push(take()); break;
      case '--browser': out.browser = take(); break;
      case '--interface': case '--iface': out.interface = take(); break;
      case '--proxy': out.proxies.push(take()); break;
      case '--count': case '-n': case '--multi': out.count = parseInt(take(), 10); break;
      case '--layout': out.layout = take(); break;
      case '--columns': out.columns = parseInt(take(), 10); break;
      case '--gap': out.gap = parseInt(take(), 10); break;
      case '--bandwidth': out.bandwidth = take(); break;
      case '--replay': case '--macro': out.macro = take(); break;
      case '--speed': out.speed = parseFloat(take()); break;
      case '--debug': out.debug = true; break;
      case '--no-debug': out.debug = false; break;
      case '--status': out.statusPage = true; break;
      case '--no-status': out.statusPage = false; break;
      case '--log-file': out.logFile = take(); out.debug = true; break;
      case '--log-level': out.logLevel = take(); out.debug = true; break;
      case '--no-log-console': out.logConsole = false; break;
      case '--seed': out.seed = take(); break;
      case '--window': out.window = take(); break;
      case '--incognito': out.incognito = true; break;
      case '--keep-profile': out.keepProfile = true; break;
      case '--no-spoof': out.noSpoof = true; break;
      case '--verbose': case '-v': out.verbose = true; break;
      case '--list-interfaces': out.listInterfaces = true; break;
      case '--list-browsers': out.listBrowsers = true; break;
      case '--install-browser': {
        // --install-browser [browser] [channel]
        out.installBrowser = argv[i + 1] && !argv[i + 1].startsWith('--') ? take() : 'chrome';
        if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.installChannel = take();
        break;
      }
      case '--no-download': out.noDownload = true; break;
      case '--print-identity': out.printIdentity = true; break;
      case '--print-config': out.printConfig = true; break;
      case '--dump-config': out.dumpConfig = true; break;
      case '--init-config': out.initConfig = true; break;
      case '--check': out.check = true; break;
      case '--app': case '--gui': case '--panel': out.app = true; break;
      case '--help': case '-h': out.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option: ${a}\n\n${HELP}`);
        out._.push(a);
    }
  }
  return out;
}

/** Where the project lives, regardless of the directory the command was run from. */
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Pick the config file to read.
 * An explicit --config wins. Otherwise a config.json in the current directory
 * wins over the one next to the code, so a per-folder config is possible - but
 * the project's own file is still found when the launcher is run from anywhere
 * else, which is the normal case for a desktop shortcut.
 */
function resolveConfigPath(args, cwd) {
  if (args.config) return { file: path.resolve(cwd, args.config), explicit: true };
  const local = path.join(cwd, 'config.json');
  if (fs.existsSync(local)) return { file: local, explicit: false };
  return { file: path.join(PROJECT_ROOT, 'config.json'), explicit: false };
}

function loadConfig(args, cwd = process.cwd()) {
  const { file, explicit } = resolveConfigPath(args, cwd);
  if (explicit && !fs.existsSync(file)) {
    throw new Error(`Config file not found: ${file}`);
  }
  let cfg = deepMerge(DEFAULTS, loadFile(file));

  const urls = [...args.urls, ...args._];
  if (urls.length) cfg.startup.urls = urls.map(normalizeUrl);
  if (args.browser) cfg.browser = args.browser;
  if (args.interface) cfg.network.interface = args.interface;
  if (args.proxies && args.proxies.length) {
    cfg.network.proxies = args.proxies;
    cfg.network.proxy = args.proxies[0];
  }
  if (Number.isFinite(args.count)) cfg.instances.count = Math.max(1, args.count);
  if (args.layout) cfg.instances.layout = args.layout;
  if (Number.isFinite(args.columns)) cfg.instances.columns = args.columns;
  if (Number.isFinite(args.gap)) cfg.instances.gap = args.gap;
  if (args.bandwidth) cfg.bandwidth.mode = args.bandwidth;
  if (args.noDownload) cfg.downloadBrowser.auto = false;
  if (args.macro) cfg.macro.file = args.macro;
  if (Number.isFinite(args.speed)) cfg.macro.speed = args.speed;
  if (args.debug !== undefined) cfg.debug.enabled = args.debug;
  if (args.statusPage !== undefined) cfg.statusPage.enabled = args.statusPage;
  if (args.logFile) cfg.debug.logFile = args.logFile;
  if (args.logLevel) cfg.debug.level = args.logLevel;
  if (args.logConsole === false) cfg.debug.console = false;
  if (args.seed) cfg.identity.seed = args.seed;
  if (args.window) cfg.startup.windowSize = args.window;
  if (args.incognito) cfg.startup.incognito = true;
  if (args.keepProfile) cfg.privacy.wipeOnExit = false;
  if (args.verbose) cfg.verbose = true;
  if (args.noSpoof) {
    cfg.identity.randomize = false;
    for (const k of Object.keys(cfg.identity.spoof)) cfg.identity.spoof[k] = false;
  }

  cfg.startup.urls = (cfg.startup.urls || []).map(normalizeUrl);
  cfg.configFile = fs.existsSync(file) ? file : null;
  cfg.configMissing = cfg.configFile ? null : file;

  // Relative log paths belong to the project, not to whichever directory the
  // launcher happened to be started from.
  if (cfg.debug.logDir && !path.isAbsolute(cfg.debug.logDir)) {
    cfg.debug.logDir = path.resolve(PROJECT_ROOT, cfg.debug.logDir);
  }
  if (cfg.debug.logFile && !path.isAbsolute(cfg.debug.logFile)) {
    cfg.debug.logFile = path.resolve(cwd, cfg.debug.logFile);
  }
  return cfg;
}

/** Effective config after DEFAULTS < config.json < CLI, minus internal fields. */
function describeConfig(cfg) {
  const { configFile, configMissing, ...rest } = cfg;
  const lines = [];
  lines.push(`  config file : ${configFile || `(NONE - looked for ${configMissing})`}`);
  lines.push('');
  lines.push('  Effective values (DEFAULTS < config.json < CLI options):');
  lines.push('');
  for (const line of JSON.stringify(rest, null, 2).split('\n')) lines.push('  ' + line);
  return lines.join('\n');
}

function normalizeUrl(u) {
  const s = String(u).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return `https://${s}`;
}

module.exports = { DEFAULTS, loadConfig, parseArgs, deepMerge, HELP, normalizeUrl, describeConfig, PROJECT_ROOT };
