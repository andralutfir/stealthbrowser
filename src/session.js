'use strict';
/**
 * One disposable browser session: its own profile, identity, proxy binding,
 * DevTools connection and log file. Several of these run side by side in
 * multi-instance mode, sharing nothing but the screen.
 */
const { spawn, execFileSync } = require('child_process');
const net = require('net');
const { EventEmitter } = require('events');

const { findBrowser, buildArgs } = require('./browser');
const { createIdentity, describeIdentity } = require('./identity');
const { createProfile, wipeProfile, dirSize } = require('./profile');
const { LocalProxy, parseUpstream } = require('./proxy');
const { resolveInterface } = require('./net');
const { getMonitor } = require('./layout');
const { CDP, waitForBrowser } = require('./cdp');
const { buildInjectScript } = require('./inject');
const { Logger, truncate, safeUrl } = require('./logger');
const { StatusPage } = require('./statuspage');
const bandwidth = require('./bandwidth');
const challenge = require('./challenge');
const { buildRecorderScript, formatEvent, shortUrl } = require('./recorder');
const { writeReport } = require('./report');
const macroLib = require('./macro');

const crypto = require('crypto');

/** Cap on events kept in memory for the HTML report; the .jsonl keeps them all. */
const MAX_TIMELINE = 20000;

// Only real content targets. Chrome's own UI surfaces (`browser_ui`, e.g. the
// omnibox popup) and extension internals must never be spoofed or logged.
const PAGE_TYPES = new Set(['page', 'iframe', 'webview']);

/**
 * Restrict auto-attach to content targets.
 *
 * Without this, `waitForDebuggerOnStart` also freezes Chrome's own UI renderers
 * the moment they appear - which is exactly what pressing Ctrl+T creates (the
 * omnibox popup, the new tab page). A paused browser UI is not something
 * Chromium tolerates, and it tears the browser down. Filtering here means those
 * targets are never attached, so they are never paused.
 */
const AUTO_ATTACH_FILTER = [
  { type: 'page', exclude: false },
  { type: 'iframe', exclude: false },
  { type: 'webview', exclude: false },
  { exclude: true },
];

/** Privileged pages: injecting into browser UI is pointless and destabilising. */
function isInternalUrl(url) {
  return /^(chrome|devtools|chrome-untrusted|chrome-extension|edge|brave):/i.test(url || '');
}

/** The browser's own new tab page, in every flavour that ships one. */
function isNewTabUrl(url) {
  return /^(chrome|brave|edge|vivaldi):\/\/(newtab|new-tab-page|newtabpage)/i.test(url || '');
}

/**
 * Arm auto-attach, preferring the filtered form and falling back for builds
 * that do not accept the parameter.
 */
async function setAutoAttach(cdp, sessionId) {
  const params = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
  try {
    await cdp.send('Target.setAutoAttach', { ...params, filter: AUTO_ATTACH_FILTER }, sessionId);
    return true;
  } catch {
    return !!(await cdp.trySend('Target.setAutoAttach', params, sessionId));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/**
 * The Emulation overrides, split out because they must never be applied to a
 * browser UI page.
 *
 * Brave wraps these APIs with its own fingerprint-protection layer, and setting
 * them on brave://newtab takes the whole browser down with STATUS_BREAKPOINT.
 * They are also pointless there - there is no site on the new tab page to hide
 * from. So an internal page gets them only once it navigates somewhere real.
 */
async function applyEmulation(cdp, sessionId, identity, spoof, state) {
  if (spoof.userAgent !== false) {
    await cdp.trySend('Emulation.setUserAgentOverride', {
      userAgent: identity.userAgent,
      acceptLanguage: identity.acceptLanguage,
      platform: identity.platform,
      userAgentMetadata: {
        brands: identity.brands,
        fullVersionList: identity.brands.map((b) => ({
          brand: b.brand,
          version: b.brand === 'Chromium' || b.brand === 'Google Chrome' ? identity.browserVersion : b.version,
        })),
        fullVersion: identity.browserVersion,
        platform: identity.chPlatform,
        platformVersion: identity.platformVersion,
        architecture: identity.architecture,
        model: identity.model,
        mobile: false,
        bitness: identity.bitness,
        wow64: false,
      },
    }, sessionId);
  }

  if (spoof.timezone !== false) {
    await cdp.trySend('Emulation.setTimezoneOverride', { timezoneId: identity.timezone }, sessionId);
  }
  // Chromium keeps a single global locale override; a second attempt errors out.
  if (spoof.locale !== false && !state.localeApplied) {
    state.localeApplied = true;
    await cdp.trySend('Emulation.setLocaleOverride', { locale: identity.locale }, sessionId);
  }
  if (spoof.geolocation !== false) {
    await cdp.trySend('Emulation.setGeolocationOverride', {
      latitude: identity.geo.latitude,
      longitude: identity.geo.longitude,
      accuracy: identity.geo.accuracy,
    }, sessionId);
  }
}

/**
 * Everything CDP can override, applied to one session.
 * `state` carries flags for overrides that are browser-global rather than
 * per-target, so they are only ever issued once.
 */
async function armSession(cdp, sessionId, identity, spoof, injectScript, state, debug, bw, recorder, internal, isChallenge) {
  await cdp.trySend('Page.enable', {}, sessionId);

  if (!internal) await applyEmulation(cdp, sessionId, identity, spoof, state);

  if (debug.enabled) {
    await cdp.trySend('Runtime.enable', {}, sessionId);
    if (recorder) await cdp.trySend('Runtime.addBinding', { name: recorder.binding }, sessionId);
    if (debug.browserLogs) await cdp.trySend('Log.enable', {}, sessionId);
  }

  // URL blocking and byte accounting both need the Network domain; enabling it
  // once here covers the debug logger too.
  if (bw.needsNetworkDomain || (debug.enabled && debug.network)) {
    await cdp.trySend('Network.enable', {}, sessionId);
  }
  // A captcha frame is left alone: its fonts, icons, puzzle images and audio
  // challenge are the whole point of the frame, and Save-Data can make a
  // provider serve a degraded variant. The blocklist is per-target, so the page
  // around it still saves everything it would have saved.
  const exempt = bw.allowChallenges && isChallenge;
  if (bw.enabled && !exempt) {
    const urls = bandwidth.blockedUrls(bw);
    if (urls.length) await cdp.trySend('Network.setBlockedURLs', { urls }, sessionId);
    const headers = bandwidth.extraHeaders(bw);
    if (headers) await cdp.trySend('Network.setExtraHTTPHeaders', { headers }, sessionId);
  }

  // On a privileged page the script is registered but not run right now; it
  // still applies to every document this tab loads afterwards.
  const runImmediately = !internal;

  if (injectScript) {
    await cdp.trySend('Page.addScriptToEvaluateOnNewDocument', {
      source: injectScript,
      runImmediately,
    }, sessionId);
  }

  // Separate script from the fingerprint patches: the recorder is optional and
  // should never be able to take those down with it if it throws.
  if (recorder) {
    await cdp.trySend('Page.addScriptToEvaluateOnNewDocument', {
      source: recorder.script,
      runImmediately,
    }, sessionId);
  }

  // Catch out-of-process iframes and popups spawned by this target.
  await setAutoAttach(cdp, sessionId);
}

class Session extends EventEmitter {
  /**
   * @param {object} cfg
   * @param {object} opts { index, total, geometry, proxyOverride, tag, quiet }
   */
  constructor(cfg, opts = {}) {
    super();
    this.cfg = cfg;
    this.opts = opts;
    this.index = opts.index || 0;
    this.tag = opts.tag || (opts.total > 1 ? `#${this.index + 1}` : '');
    this.quiet = !!opts.quiet;
    this.stopped = false;
    this.exitCode = 0;
    this.startedAt = Date.now();
    this.timeline = [];
  }

  say(line) { if (!this.quiet) console.log(this.tag ? `${this.tag} ${line}` : line); }

  /**
   * Smallest screen the persona may claim.
   *
   * Whenever the real window size is decided outside the persona - tiled multi
   * mode, "maximized", or an explicit WxH - the spoofed screen has to be able
   * to contain it. A window wider than the screen it supposedly sits on is an
   * impossible combination, and that contradiction is a stronger signal than
   * the real resolution would have been.
   */
  _minWindow() {
    const g = this.opts.geometry;
    if (g) return { width: g.width, height: g.height };

    const size = (this.cfg.startup || {}).windowSize;
    if (size === 'maximized') {
      const mon = getMonitor((this.cfg.instances || {}).monitor);
      return { width: mon.width, height: mon.height };
    }
    if (typeof size === 'string' && /^\d+x\d+$/.test(size)) {
      const [w, h] = size.split('x').map(Number);
      return { width: w, height: h };
    }
    return null;
  }

  async start() {
    const cfg = this.cfg;
    const debugCfg = cfg.debug || {};
    const spoof = cfg.identity.spoof || {};

    const nt = (cfg.startup || {}).newTabUrl;
    // null/"" means "leave the browser's own new tab page alone".
    this.newTabUrl = (typeof nt === 'string' && nt.trim()) ? nt.trim() : null;

    this.bw = bandwidth.resolve(cfg.bandwidth);
    this.meter = new bandwidth.Meter();

    this.binary = findBrowser(cfg.browser);
    // A fixed seed must still yield a *different* persona per instance,
    // otherwise multi mode would open several clones of the same identity.
    const idCfg = (cfg.identity.seed && (this.opts.total || 1) > 1)
      ? { ...cfg, identity: { ...cfg.identity, seed: `${cfg.identity.seed}#${this.index}` } }
      : cfg;
    this.identity = createIdentity(idCfg, this.binary, { minWindow: this._minWindow() });

    this.logger = new Logger({
      enabled: !!debugCfg.enabled,
      file: debugCfg.logFile || null,
      dir: debugCfg.logDir || 'logs',
      level: debugCfg.level || 'info',
      toConsole: debugCfg.console !== false,
      jsonl: debugCfg.jsonl !== false,
      tag: this.tag || `${this.identity.seed.slice(0, 8)}`,
    });

    // ---- network ----------------------------------------------------------
    const proxySpec = this.opts.proxyOverride !== undefined ? this.opts.proxyOverride : cfg.network.proxy;
    this.iface = resolveInterface(cfg.network.interface);
    this.upstream = parseUpstream(proxySpec);
    this.proxy = null;
    let proxyUrl = null;

    if (this.iface || this.upstream || (cfg.network.blockHosts || []).length) {
      this.proxy = new LocalProxy({
        localAddress: this.iface ? this.iface.address : undefined,
        upstream: this.upstream,
        dnsServers: cfg.network.dnsServers,
        blockHosts: [...(cfg.network.blockHosts || []), ...bandwidth.blockedHosts(this.bw)],
        verbose: cfg.verbose,
      });
      const port = await this.proxy.listen();
      proxyUrl = `http://127.0.0.1:${port}`;
    }

    // ---- profile + process ------------------------------------------------
    this.profile = createProfile(cfg, this.identity);
    const debugPort = await freePort();
    this.deferUrls = cfg.startup.deferUrls !== false;
    const argv = buildArgs({
      cfg,
      identity: this.identity,
      profile: this.profile,
      debugPort,
      proxyUrl,
      geometry: this.opts.geometry,
      bandwidthFlags: bandwidth.browserFlags(this.bw),
    });

    this.say('');
    this.say(`  ${this.binary.name} ${this.binary.version || ''}`.trimEnd());
    this.say(`  config       : ${cfg.configFile || '(none - using defaults)'}`);
    this.say(`  profile      : ${this.profile.dir}${this.profile.ephemeral ? '  (wiped on exit)' : '  (KEPT)'}`);
    this.say(`  network      : ${this.iface ? `${this.iface.name} (${this.iface.address}) [${this.iface.kind}]` : 'default route'}`
      + (this.upstream ? ` -> ${this.upstream.label}` : '')
      + (proxyUrl ? `  via ${proxyUrl}` : ''));
    if (this.opts.geometry) {
      const g = this.opts.geometry;
      this.say(`  window       : ${g.width}x${g.height} @ ${g.left},${g.top}`);
    }
    if (this.bw.enabled) this.say(`  bandwidth    : ${bandwidth.describe(this.bw)}`);
    if (this.logger.path) this.say(`  log          : ${this.logger.path}`);

    // Status tab: served locally so it paints instantly, and it goes first so
    // the identity is on screen before any real site loads.
    if ((cfg.statusPage || {}).enabled) {
      try {
        this.statusPage = new StatusPage({
          identity: this.identity,
          profile: this.profile,
          iface: this.iface,
          upstream: this.upstream,
          browser: this.binary,
          tag: this.tag,
          bandwidth: bandwidth.describe(this.bw),
          mode: cfg.statusPage.mode,
          checkIp: cfg.statusPage.checkIp,
          ipService: cfg.statusPage.ipService,
          ipFallback: cfg.statusPage.ipFallback,
          checkQuality: cfg.statusPage.checkQuality,
          qualityService: cfg.statusPage.qualityService,
        });
        this.statusUrl = await this.statusPage.listen();
        this.say(`  status       : ${this.statusUrl}`);
      } catch (e) {
        this.say(`  status       : failed to start (${e.message})`);
        this.statusPage = null;
      }
    }
    if (cfg.identity.randomize !== false) {
      this.say('  identity     :');
      for (const line of describeIdentity(this.identity).split('\n')) this.say(line);
    } else {
      this.say('  identity     : spoofing disabled');
    }
    this.say('');

    this.logger.header([
      `stealthbrowser session ${this.tag || ''}`.trim(),
      `time      : ${new Date().toISOString()}`,
      `browser   : ${this.binary.name} ${this.binary.version || ''}`,
      `profile   : ${this.profile.dir}`,
      `network   : ${this.iface ? `${this.iface.name} ${this.iface.address}` : 'default'}${this.upstream ? ` -> ${this.upstream.label}` : ''}`,
      describeIdentity(this.identity),
    ]);

    if (cfg.verbose) console.log(`[launch] ${this.binary.path}\n  ${argv.join('\n  ')}\n`);

    this.child = spawn(this.binary.path, argv, {
      stdio: cfg.verbose ? ['ignore', 'inherit', 'inherit'] : 'ignore',
      windowsHide: false,
    });

    this.child.on('error', (e) => {
      console.error(`${this.tag} Failed to launch the browser: ${e.message}`);
      this.exitCode = 1;
      this.stop('spawn error');
    });
    this.child.on('exit', (code) => {
      this.exitCode = code === null ? 0 : code;
      this.stop(`browser exited (code ${code})`);
    });

    await this._connect(debugPort, spoof, debugCfg);
  }

  async _connect(debugPort, spoof, debugCfg) {
    const cfg = this.cfg;
    let version;
    try {
      version = await waitForBrowser(debugPort);
    } catch (e) {
      console.error(`${this.tag} WARNING: DevTools never connected (${e.message}). JS-level spoofing is off.`);
      return;
    }

    const cdp = new CDP(version.webSocketDebuggerUrl);
    try {
      await cdp.ready;
    } catch (e) {
      cdp.close();
      console.error(`${this.tag} WARNING: DevTools refused the connection (${e.message}). JS-level spoofing is off.`);
      return;
    }
    this.cdp = cdp;
    cdp.verbose = cfg.verbose;

    const injectScript = cfg.identity.randomize === false
      ? null
      : buildInjectScript(this.identity, spoof);

    // Randomised names: a fixed `window.__sbLog` would be a global any site
    // could probe for, undoing the work the rest of the project does to hide.
    const recorder = (debugCfg.enabled && debugCfg.interactions !== false) ? {
      binding: '__sb' + crypto.randomBytes(6).toString('hex'),
      flag: '__sb' + crypto.randomBytes(6).toString('hex'),
    } : null;
    if (recorder) {
      recorder.script = buildRecorderScript({
        binding: recorder.binding,
        flag: recorder.flag,
        captureValues: debugCfg.captureValues !== false,
        redactSecrets: debugCfg.redactSecrets !== false,
        maxValue: debugCfg.maxValueLength,
        captureKeys: debugCfg.captureKeys !== false,
        captureScroll: debugCfg.captureScroll !== false,
        typeIdleMs: debugCfg.typeIdleMs,
      });
      this.recorder = recorder;
    }

    const state = { localeApplied: false };
    // Sessions that attached on a browser UI page: they are armed in full the
    // moment they navigate somewhere real.
    const armPending = new Map();
    const debug = {
      enabled: !!debugCfg.enabled,
      interactions: debugCfg.interactions !== false,
      network: debugCfg.network !== false,
      browserLogs: debugCfg.browserLogs !== false,
      console: debugCfg.captureConsole !== false,
    };

    const pages = new Set();
    const sessions = new Map();  // targetId -> { sessionId, armed }
    const waiters = new Map();   // targetId -> resolve()
    const tabOf = new Map();     // sessionId -> label
    const bwExempt = new Map();  // sessionId -> bandwidth blocking lifted?
    let tabCounter = 0;
    let sawFirstPage = false;

    const sessionFor = (targetId, timeoutMs = 15000) => {
      if (sessions.has(targetId)) return Promise.resolve(sessions.get(targetId));
      return new Promise((resolve, reject) => {
        waiters.set(targetId, resolve);
        setTimeout(() => {
          if (waiters.delete(targetId)) reject(new Error(`no session appeared for target ${targetId}`));
        }, timeoutMs);
      });
    };

    cdp.on('event', (msg) => {
      try {
        this._onEvent(msg, { cdp, sessions, waiters, pages, tabOf, debug, state, spoof, injectScript, recorder, armPending, bwExempt,
          nextTab: () => `tab${++tabCounter}`,
          markPage: () => { sawFirstPage = true; },
          allClosed: () => sawFirstPage && pages.size === 0,
        });
      } catch (e) {
        if (cfg.verbose) console.log(`[cdp] handler error: ${e.message}`);
      }
    });

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await setAutoAttach(cdp);

    if (this.deferUrls) {
      let browserContextId;
      if (cfg.startup.incognito) {
        const ctx = await cdp.trySend('Target.createBrowserContext', { disposeOnDetach: true });
        browserContextId = ctx && ctx.browserContextId;
      }
      const configured = cfg.startup.urls.length ? cfg.startup.urls : ['about:blank'];
      // Status tab first, then everything the user configured.
      const urls = this.statusUrl ? [this.statusUrl, ...configured] : configured;
      let lastPageSession = null;
      for (let i = 0; i < urls.length; i++) {
        // Open blank, arm the session, *then* navigate. Handing the real URL to
        // createTarget races the load against the overrides, and a fast server
        // (or anything cached) wins that race - the page then reads real values.
        const created = await cdp.trySend('Target.createTarget', {
          url: 'about:blank', newWindow: i === 0, browserContextId,
        });
        if (!created || !created.targetId || urls[i] === 'about:blank') continue;
        try {
          const s = await sessionFor(created.targetId);
          await s.armed;
          await cdp.trySend('Page.navigate', { url: urls[i] }, s.sessionId);
          lastPageSession = s.sessionId;
        } catch (e) {
          if (cfg.verbose) console.log(`[cdp] navigation to ${urls[i]} failed: ${e.message}`);
        }
      }
      this.say(`  opened       : ${configured.join(', ')}${this.statusUrl ? '  (+ status tab)' : ''}`);
      this.say('');

      // Replay runs in the tab the macro was recorded against, i.e. the last
      // configured URL rather than the status page.
      const macroFile = (cfg.macro || {}).file;
      if (macroFile && lastPageSession) {
        await this._runMacro(cdp, lastPageSession, macroFile);
      } else if (macroFile) {
        this.say('  macro        : no page to replay into');
      }
    }
  }

  /** Replay a recorded macro into an already-armed page session. */
  async _runMacro(cdp, sessionId, file) {
    let macro;
    try {
      macro = macroLib.load(file);
    } catch (e) {
      this.say(`  macro        : cannot read ${file} (${e.message})`);
      return;
    }
    if (!macro.steps.length) {
      this.say(`  macro        : ${file} has no replayable steps`);
      return;
    }

    const cfg = this.cfg.macro || {};
    this.say(`  macro        : ${macroLib.describe(macro)}`);
    if (this.logger) this.logger.info('macro', `replaying ${macro.source}: ${macroLib.describe(macro)}`);

    const player = new macroLib.Player(cdp, sessionId, {
      speed: cfg.speed,
      maxDelayMs: cfg.maxDelayMs,
      waitForMs: cfg.waitForMs,
      stopOnMissing: cfg.stopOnMissing,
      secrets: cfg.secrets,
      onStep: (s) => {
        const line = `${String(s.index).padStart(3)}/${s.total}  ${s.verb.padEnd(7)} ${s.text}`;
        this.say(`  ${s.ok ? '   ' : '  !'}${line}`);
        this._record('MACRO', line, '-', { ok: s.ok, step: s.index });
      },
    });

    const stats = await player.run(macro);
    const summary = `${stats.done} done, ${stats.skipped} skipped, ${stats.failed} failed`;
    this.say(`  macro        : ${summary}`);
    if (this.logger) this.logger.info('macro', summary);
  }

  /**
   * Append one entry to the recording: the readable log line, the structured
   * jsonl record, and the in-memory timeline the HTML report is built from.
   */
  /**
   * Lift or restore bandwidth blocking for one target, following where its
   * frames go. Called on every navigation, and cheap when nothing changed.
   *
   * A challenge in any frame lifts it for the whole target, because a
   * same-process iframe shares the target's blocklist and there is no finer
   * handle to pull. Only a main-frame navigation puts it back.
   *
   * @param {string} url        where the frame just went
   * @param {boolean} isMain    main frame of this target
   * @param {Map} bwExempt      sessionId -> currently exempt?
   */
  _reconcileBandwidth(cdp, sessionId, url, isMain, bwExempt) {
    const bw = this.bw;
    if (!bw || !bw.enabled || !bw.allowChallenges || !bwExempt) return;
    const hit = challenge.isChallengeUrl(url);
    if (!hit && !isMain) return;          // a plain subframe changes nothing
    const want = hit;
    if (bwExempt.get(sessionId) === want) return;
    bwExempt.set(sessionId, want);

    const urls = want ? [] : bandwidth.blockedUrls(bw);
    cdp.trySend('Network.setBlockedURLs', { urls }, sessionId);
    const headers = want ? {} : (bandwidth.extraHeaders(bw) || {});
    cdp.trySend('Network.setExtraHTTPHeaders', { headers }, sessionId);
    if (this.cfg.verbose) {
      console.log(`[cdp] bandwidth ${want ? 'lifted for' : 'restored after'} ${shortUrl(url)}`);
    }
  }

  _record(verb, text, tab, data) {
    const level = ['ERROR', 'FAILED', 'DIALOG'].includes(verb) ? 'error' : 'info';
    if (this.logger) {
      this.logger.log(level, verb.toLowerCase(), `${tab && tab !== '-' ? tab + '  ' : ''}${text}`);
      this.logger.event(Object.assign({ verb, tab, text }, data || {}));
    }
    if (!this.timeline) this.timeline = [];
    if (this.timeline.length < MAX_TIMELINE) {
      this.timeline.push({ at: Date.now() - this.startedAt, verb, text, tab });
    }
  }

  _onEvent(msg, ctx) {
    const { cdp, sessions, waiters, pages, tabOf, debug, state, spoof, injectScript, recorder, armPending } = ctx;
    const log = this.logger;
    const sid = msg.sessionId;
    const tab = (sid && tabOf.get(sid)) || '-';

    switch (msg.method) {
      case 'Target.attachedToTarget': {
        const { sessionId, targetInfo } = msg.params;
        if (PAGE_TYPES.has(targetInfo.type)) tabOf.set(sessionId, ctx.nextTab());
        const armed = (async () => {
          if (PAGE_TYPES.has(targetInfo.type)) {
            // A tab opened with Ctrl+T starts on the browser's new tab page. It
            // still has to be armed - the user is about to type a real URL into
            // it - but the scripts must not be *executed* inside browser UI, so
            // there they are only registered for the documents that follow.
            // Browser UI pages get nothing but Page.enable.
            //
            // Brave's new tab page is a WebUI wrapped in Brave's own
            // fingerprint-protection layer, and instrumenting it - Emulation
            // overrides, extra HTTP headers, runtime bindings - takes the whole
            // browser down with STATUS_BREAKPOINT. None of it is any use there
            // either: there is no site on the new tab page to hide from.
            //
            // So the tab is redirected straight off the built-in page and armed
            // properly the moment it lands somewhere real. about:blank is the
            // bridge: nothing can read a fingerprint from it.
            if (isInternalUrl(targetInfo.url)) {
              await cdp.trySend('Page.enable', {}, sessionId);
              if (this.newTabUrl && isNewTabUrl(targetInfo.url)) {
                await cdp.trySend('Page.navigate', { url: this.newTabUrl }, sessionId);
              }
              armPending.set(sessionId, true);
              if (this.cfg.verbose) console.log(`[cdp] deferred ${targetInfo.url}`);
            } else {
              const isChallenge = challenge.isChallengeUrl(targetInfo.url);
              ctx.bwExempt.set(sessionId, !!(this.bw.allowChallenges && isChallenge));
              await armSession(cdp, sessionId, this.identity, spoof, injectScript,
                state, debug, this.bw, recorder, false, isChallenge);
              if (this.cfg.verbose) {
                console.log(`[cdp] armed ${targetInfo.type} ${targetInfo.url || '(blank)'}`);
              }
            }
          }
          await cdp.trySend('Runtime.runIfWaitingForDebugger', {}, sessionId);
        })();
        const entry = { sessionId, armed };
        sessions.set(targetInfo.targetId, entry);
        const w = waiters.get(targetInfo.targetId);
        if (w) { waiters.delete(targetInfo.targetId); w(entry); }
        break;
      }
      case 'Target.targetCreated': {
        const t = msg.params.targetInfo;
        if (t.type === 'page') { pages.add(t.targetId); ctx.markPage(); }
        break;
      }
      case 'Target.targetDestroyed': {
        pages.delete(msg.params.targetId);
        sessions.delete(msg.params.targetId);
        if (ctx.allClosed()) this.stop('all tabs closed');
        break;
      }

      // ---- debug logging ----------------------------------------------------
      case 'Page.frameNavigated': {
        const f = msg.params.frame;
        // A challenge frame is usually attached before it has a URL, so the
        // exemption cannot be decided at arming time alone - it is settled here,
        // once the frame says where it went.
        if (f && sid) this._reconcileBandwidth(cdp, sid, f.url, !f.parentId, ctx.bwExempt);
        if (f && !f.parentId) {
          // The tab has left the browser UI, so arming it is now both safe
          // and necessary.
          if (sid && armPending && armPending.has(sid) && !isInternalUrl(f.url)) {
            armPending.delete(sid);
            armSession(cdp, sid, this.identity, spoof, injectScript,
              state, debug, this.bw, recorder, false, challenge.isChallengeUrl(f.url))
              .then(() => { if (this.cfg.verbose) console.log(`[cdp] armed ${tab} after leaving browser UI`); })
              .catch(() => {});
          }
          this._record('NAV', shortUrl(f.url), tab, { url: f.url, mimeType: f.mimeType });
        }
        break;
      }
      case 'Page.javascriptDialogOpening':
        this._record('DIALOG', `${msg.params.type}: ${truncate(msg.params.message, 200)}`, tab,
          { dialog: msg.params.type, message: truncate(msg.params.message, 200) });
        break;
      case 'Page.downloadWillBegin':
        this._record('DOWNLOAD', `${msg.params.suggestedFilename || '(unnamed)'}  from ${shortUrl(msg.params.url)}`, tab,
          { file: msg.params.suggestedFilename, url: msg.params.url });
        break;
      case 'Page.windowOpen':
        this._record('POPUP', shortUrl(msg.params.url), tab, { url: msg.params.url });
        break;
      case 'Page.fileChooserOpened':
        this._record('FILEPICK', 'file chooser opened', tab, {});
        break;

      case 'Runtime.consoleAPICalled': {
        if (!debug.console) break;
        const args = (msg.params.args || [])
          .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
          .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)));
        const level = msg.params.type === 'error' ? 'error' : msg.params.type === 'warning' ? 'warn' : 'debug';
        log.log(level, 'console', `${tab} [${msg.params.type}] ${truncate(args.join(' '), 500)}`);
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = msg.params.exceptionDetails || {};
        const text = (d.exception && (d.exception.description || d.exception.value)) || d.text;
        // First line only: stack traces belong in the jsonl, not the timeline.
        this._record('ERROR', truncate(String(text).split('\n')[0], 300), tab,
          { url: d.url, line: d.lineNumber });
        break;
      }
      case 'Runtime.bindingCalled': {
        if (!recorder || msg.params.name !== recorder.binding) break;
        let ev;
        try { ev = JSON.parse(msg.params.payload); } catch { break; }
        const { verb, text } = formatEvent(ev);
        this._record(verb, text, tab, ev);
        break;
      }
      case 'Log.entryAdded': {
        const e = msg.params.entry || {};
        const level = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'debug';
        log.log(level, e.source || 'browser', `${tab} ${truncate(e.text, 400)}`, { url: e.url ? safeUrl(e.url) : undefined });
        break;
      }

      case 'Network.requestWillBeSent': {
        if (!debug.network) break;
        const r = msg.params.request || {};
        log.debug('net', `${tab} ${r.method} ${safeUrl(r.url)}`, { type: msg.params.type });
        break;
      }
      case 'Network.responseReceived': {
        const resp = msg.params.response || {};
        if (resp.fromDiskCache || resp.fromPrefetchCache) this.meter.cached();
        if (!debug.network) break;
        const r = resp;
        const level = r.status >= 400 ? 'warn' : 'debug';
        log.log(level, 'net', `${tab} ${r.status} ${safeUrl(r.url)}`, { type: msg.params.type, from: r.remoteIPAddress });
        break;
      }
      case 'Network.loadingFinished': {
        this.meter.finished(msg.params);
        break;
      }
      case 'Network.loadingFailed': {
        this.meter.failed(msg.params);
        if (!debug.network) break;
        if (msg.params.canceled) break;
        // A blocked request is the feature working, not a problem to shout about.
        if (msg.params.blockedReason) {
          log.debug('net', `${tab} blocked ${msg.params.type || ''}`.trim());
          break;
        }
        log.warn('net', `${tab} FAILED ${msg.params.errorText}`, { type: msg.params.type });
        break;
      }
      default:
        break;
    }
  }

  async stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.cfg.verbose) console.log(`${this.tag} [shutdown] ${reason}`);
    if (this.logger) this.logger.info('session', `stopping: ${reason}`);

    if (this.cdp) {
      // A browser that is already going down may never answer this; keep the
      // wait short so cleanup is not held hostage to it.
      await this.cdp.trySend('Browser.close', {}, undefined, 3000).catch(() => {});
      this.cdp.close();
    }
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      await new Promise((r) => {
        const timer = setTimeout(r, 4000);
        this.child.once('exit', () => { clearTimeout(timer); r(); });
      });
    }
    if (this.child && this.child.exitCode === null) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          this.child.kill('SIGKILL');
        }
      } catch {}
    }

    if (this.statusPage) this.statusPage.close();

    // Only meaningful if the session got far enough to load anything.
    if (this.cdp && this.bw && this.bw.enabled && this.bw.report) {
      this.say(`  bandwidth    : ${this.meter.summary()}`);
      if (this.logger) this.logger.info('bandwidth', this.meter.summary());
    }

    if (this.proxy) {
      const s = this.proxy.stats;
      this.say(`  proxy        : ${s.requests + s.tunnels} connections`
        + (s.blocked ? `, ${s.blocked} blocked` : '')
        + (s.errors ? `, ${s.errors} errors` : ''));
      if (this.logger) this.logger.info('proxy', `connections=${s.requests + s.tunnels} blocked=${s.blocked} errors=${s.errors}`);
      this.proxy.close();
    }

    if (this.profile && this.profile.ephemeral) {
      const size = dirSize(this.profile.dir);
      const ok = await wipeProfile(this.profile, { verbose: this.cfg.verbose });
      this.say(ok
        ? `  cleaned      : ${bytes(size)} profile wiped (cookies, cache, history, localStorage)`
        : `  WARNING      : could not delete ${this.profile.dir} - remove it manually`);
    } else if (this.profile) {
      this.say(`  profile kept at ${this.profile.dir}`);
    }

    if (this.logger && this.logger.enabled) {
      const dbg = this.cfg.debug || {};
      this.say(`  recording    : ${this.timeline.length} events, ${this.logger.counts.total} log entries`);
      this.say(`                 ${this.logger.path}`);
      if (this.logger.jsonlPath) this.say(`                 ${this.logger.jsonlPath}`);

      if (dbg.htmlReport !== false) {
        try {
          const file = this.logger.path.replace(/\.log$/, '') + '.html';
          writeReport(file, {
            tag: this.tag,
            browser: `${this.binary.name} ${this.binary.version || ''}`.trim(),
            network: this.iface ? `${this.iface.name} (${this.iface.address})` : 'default route',
            proxy: this.upstream ? this.upstream.label : null,
            bandwidthMode: this.bw ? bandwidth.describe(this.bw) : 'off',
            bandwidth: this.bw && this.bw.enabled ? bandwidth.formatBytes(this.meter.bytes) : null,
            profile: this.profile ? this.profile.dir : '',
            urls: (this.cfg.startup || {}).urls || [],
            identity: this.identity,
            started: this.startedAt,
            ended: Date.now(),
          }, this.timeline);
          this.say(`                 ${file}   <- open this one`);
        } catch (e) {
          this.say(`  recording    : could not write the HTML report (${e.message})`);
        }
      }
      await this.logger.close();
    }
    this.emit('exit', this.exitCode);
  }
}

module.exports = { Session };
