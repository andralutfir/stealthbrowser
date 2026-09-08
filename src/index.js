#!/usr/bin/env node
'use strict';
/**
 * stealthbrowser - launcher for disposable browser sessions.
 *
 * Each instance: fresh throwaway profile, fresh randomised identity, optional
 * outbound interface pinning and proxy, everything wiped on exit. Run several
 * at once and they share only the screen - never an identity.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig, parseArgs, HELP, describeConfig, PROJECT_ROOT } = require('./config');
const { findBrowser, listBrowsers } = require('./browser');
const { createIdentity, describeIdentity } = require('./identity');
const { sweepOrphans } = require('./profile');
const { parseUpstream } = require('./proxy');
const { listInterfaces, resolveInterface, formatInterfaces } = require('./net');
const { computeTiles, describeLayout, getMonitor } = require('./layout');
const { Session } = require('./session');
const downloader = require('./download');

function log(...a) { console.log(...a); }

/**
 * A machine with no browser at all cannot do anything useful, so fetch one
 * rather than failing. Only when nothing is installed - an existing browser is
 * always preferred over a download.
 */
async function ensureBrowser(cfg) {
  if (cfg.browser && cfg.browser !== 'auto') return;
  if (listBrowsers(cfg).length) return;
  if (!cfg.downloadBrowser || cfg.downloadBrowser.auto === false) return;

  log('');
  log('  No browser found on this machine. Fetching one...');
  log('  (Chrome for Testing: a portable build, nothing is installed)');
  try {
    await downloader.install(cfg, { log });
  } catch (e) {
    console.error(`  Could not download a browser: ${e.message}`);
    console.error('  Install Chrome, Brave or Edge, or set "browser" to an executable path.');
  }
  log('');
}

async function launchAll(cfg) {
  await ensureBrowser(cfg);
  const swept = sweepOrphans(cfg);
  if (swept && cfg.verbose) log(`[profile] swept ${swept} leftover profile(s) from earlier runs`);

  const count = Math.max(1, Number(cfg.instances.count) || 1);
  const tiles = count > 1 || cfg.instances.layout === 'tile'
    ? computeTiles(count, {
      layout: cfg.instances.layout,
      columns: cfg.instances.columns,
      monitor: cfg.instances.monitor,
      gap: cfg.instances.gap,
      maxPerRow: cfg.instances.maxPerRow,
    })
    : null;

  // Only coordinate geometry when there is something to coordinate; a single
  // instance keeps its persona's own window size unless tiling was asked for.
  const useTiles = count > 1 && tiles;

  if (count > 1) {
    log('');
    log(`  ${describeLayout(count, tiles, { monitor: cfg.instances.monitor })}`);
    log('  every instance gets its own identity, profile and cookie jar');
  }

  const proxies = (cfg.network.proxies && cfg.network.proxies.length)
    ? cfg.network.proxies
    : null;

  const sessions = [];
  let alive = 0;

  for (let i = 0; i < count; i++) {
    const s = new Session(cfg, {
      index: i,
      total: count,
      geometry: useTiles ? tiles[i] : null,
      proxyOverride: proxies ? proxies[i % proxies.length] : undefined,
    });
    sessions.push(s);
    alive++;
    s.on('exit', () => {
      alive--;
      if (alive <= 0) {
        log('');
        process.exit(0);
      }
    });
  }

  let stopping = false;
  const stopAll = (reason) => {
    stopping = true;
    return Promise.all(sessions.map((s) => s.stop(reason)));
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { stopAll(sig); });
  }

  for (const s of sessions) {
    // Instances start staggered, so a Ctrl+C part-way through must not go on
    // opening the ones that had not launched yet.
    if (stopping) { await s.stop('cancelled before start'); continue; }
    try {
      await s.start();
    } catch (e) {
      // Tag first, like every other per-instance line, so the failure lands in
      // that instance's log rather than in the shared one.
      console.error(`${s.tag || '#1'} failed to start: ${e.message}`);
      await s.stop('failed to start');
    }
    // A small stagger keeps several Chromium cold starts from fighting over the
    // same disk and CPU, which otherwise slows every window down.
    if (count > 1 && s !== sessions[sessions.length - 1]) {
      await new Promise((r) => setTimeout(r, cfg.instances.staggerMs || 700));
    }
  }
}

/**
 * The control panel: a local server plus a browser window opened with --app=.
 * Node holds the process open until the window is closed or Ctrl+C is pressed,
 * so the panel behaves like an application rather than a command that returns.
 */
async function openPanel(cfg) {
  const { ControlPanel } = require('./app');
  const panel = new ControlPanel(cfg);
  const url = await panel.listen();
  log('');
  log('  Stealth Browser control panel');
  log(`  ${url}`);
  log('');

  const win = panel.openWindow(log);
  const shutdown = () => { panel.close(); process.exit(0); };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
  if (win) {
    win.on('exit', () => {
      log('  Panel window closed.');
      shutdown();
    });
  } else {
    log('  Leave this window open while you use the panel. Ctrl+C to stop.');
  }
  return null;   // the panel owns the process lifecycle from here
}

function runCheck(cfg) {
  const rows = [];
  const ok = (label, detail) => rows.push(`  [ok]   ${label}${detail ? ' - ' + detail : ''}`);
  const bad = (label, detail) => rows.push(`  [FAIL] ${label}${detail ? ' - ' + detail : ''}`);

  const major = parseInt(process.versions.node.split('.')[0], 10);
  major >= 18 ? ok('Node.js', process.version) : bad('Node.js', `${process.version}, needs >= 18`);

  const osName = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform;
  ok('Platform', `${osName} ${process.arch}`);

  cfg.configFile
    ? ok('Config file', cfg.configFile)
    : bad('Config file', `none at ${cfg.configMissing} - using defaults`);

  const browsers = listBrowsers(cfg);
  browsers.length
    ? ok('Browsers detected', browsers.map((b) => b.id).join(', '))
    : bad('Browsers detected', 'no Chromium installed');

  try {
    const b = findBrowser(cfg.browser, cfg);
    ok('Selected browser', `${b.name} ${b.version || '(version unreadable)'}`);
  } catch (e) { bad('Selected browser', e.message); }

  try {
    const iface = resolveInterface(cfg.network.interface);
    ok('Network interface', iface ? `${iface.name} ${iface.address}` : 'auto (default route)');
  } catch (e) { bad('Network interface', e.message); }

  try {
    const list = (cfg.network.proxies && cfg.network.proxies.length)
      ? cfg.network.proxies
      : (cfg.network.proxy ? [cfg.network.proxy] : []);
    if (!list.length) ok('Proxy', 'not used');
    else ok('Proxy', list.map((p) => parseUpstream(p).label).join(', '));
  } catch (e) { bad('Proxy', e.message); }

  const root = cfg.privacy.profileRoot || os.tmpdir();
  try {
    const probe = path.join(root, `sb-probe-${Date.now()}`);
    fs.mkdirSync(probe); fs.rmSync(probe, { recursive: true, force: true });
    ok('Profile folder', root);
  } catch (e) { bad('Profile folder', `${root}: ${e.message}`); }

  if (cfg.debug.enabled) {
    const dir = path.resolve(cfg.debug.logDir || 'logs');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      ok('Log folder', dir);
    } catch (e) { bad('Log folder', `${dir}: ${e.message}`); }
  } else {
    ok('Debug log', 'disabled');
  }

  const mon = getMonitor(cfg.instances.monitor);
  ok('Monitor', `${mon.width}x${mon.height} (${mon.source})`);
  const n = Math.max(1, Number(cfg.instances.count) || 1);
  ok('Instances', describeLayout(n, computeTiles(n, {
    layout: cfg.instances.layout, columns: cfg.instances.columns,
    monitor: cfg.instances.monitor, gap: cfg.instances.gap,
  }), { monitor: cfg.instances.monitor }));

  ok('Interfaces available', String(listInterfaces().length));
  log(rows.join('\n'));
  return rows.some((r) => r.startsWith('  [FAIL')) ? 1 : 0;
}

/** Rewrite config.json from the fully documented example, keeping a backup. */
function initConfig() {
  const target = path.join(PROJECT_ROOT, 'config.json');
  const source = path.join(PROJECT_ROOT, 'config.example.json');
  if (!fs.existsSync(source)) {
    console.error(`  config.example.json not found in ${PROJECT_ROOT}`);
    return 1;
  }
  if (fs.existsSync(target)) {
    const backup = `${target}.bak`;
    fs.copyFileSync(target, backup);
    log(`  previous config.json backed up to ${backup}`);
  }
  fs.copyFileSync(source, target);
  log(`  new config.json written from config.example.json`);
  log(`  ${target}`);
  log('');
  log('  Everything in it is at its default. Change only what you need,');
  log('  then verify with: node src/index.js --print-config');
  return 0;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) { console.error(e.message); return 1; }

  if (args.help) { log(HELP); return 0; }

  if (args.listInterfaces) {
    log('\nNetwork interfaces:\n');
    log(formatInterfaces());
    log('\nUse with: --interface "Ethernet"  |  --interface wifi  |  --interface 192.168.0.69\n');
    return 0;
  }

  if (args.listBrowsers) {
    let cfgForList = {};
    try { cfgForList = loadConfig(args); } catch { /* listing should work regardless */ }
    const found = listBrowsers(cfgForList);
    log('\nDetected browsers:\n');
    if (!found.length) log('  (none installed)');
    for (const b of found) log(`  ${b.id.padEnd(11)} ${b.path}${b.downloaded ? '   [downloaded]' : ''}`);
    log('\nAvailable to download (portable archives - nothing is installed):\n');
    try {
      for (const b of await downloader.available()) {
        if (b.error) { log(`  ${b.id.padEnd(10)} unavailable - ${b.error}`); continue; }
        log(`  ${b.id.padEnd(10)} ${b.channel.padEnd(9)} ${String(b.version).padEnd(16)} ${b.note}`);
      }
    } catch (e) {
      log(`  (could not reach the version lists: ${e.message})`);
    }

    log('\nInstaller only - install these yourself and they are detected:\n');
    for (const [id, b] of Object.entries(downloader.INSTALLER_ONLY)) {
      log(`  ${id.padEnd(10)} ${b.name.padEnd(17)} ${b.url}`);
    }
    log('\n  Fetch one with:  node src/index.js --install-browser brave');
    log('');
    return 0;
  }

  if (args.initConfig) return initConfig();

  let cfg;
  try { cfg = loadConfig(args); } catch (e) { console.error(e.message); return 1; }

  if (args.installBrowser) {
    try {
      log('');
      const exe = await downloader.install(cfg, {
        browser: args.installBrowser, channel: args.installChannel, log,
      });
      void exe;
      log('');
      log('  Leave "browser" on "auto" and this one is used when nothing else is installed.');
      log('');
      return 0;
    } catch (e) {
      console.error(`  Download failed: ${e.message}`);
      return 1;
    }
  }

  if (args.dumpConfig) {
    // Raw JSON for programmatic readers such as the GUI. Internal bookkeeping
    // fields are stripped so the output round-trips back into config.json.
    const { configFile, configMissing, ...rest } = cfg;
    process.stdout.write(JSON.stringify({ configFile, configMissing, config: rest }, null, 2));
    return 0;
  }

  if (args.printConfig) {
    log('');
    log(describeConfig(cfg));
    log('');
    return 0;
  }

  if (cfg.configMissing) {
    console.error(`  WARNING      : no config.json found (looked for ${cfg.configMissing}).`);
    console.error('                 Running with defaults. Create one with: node src/index.js --init-config');
  }

  if (args.app) return openPanel(cfg);

  if (args.check) return runCheck(cfg);

  if (args.printIdentity) {
    const binary = findBrowser(cfg.browser);
    const n = Math.max(1, Number(cfg.instances.count) || 1);
    log('');
    for (let i = 0; i < n; i++) {
      if (n > 1) log(`  --- instance #${i + 1} ---`);
      const idCfg = (cfg.identity.seed && n > 1)
        ? { ...cfg, identity: { ...cfg.identity, seed: `${cfg.identity.seed}#${i}` } }
        : cfg;
      log(describeIdentity(createIdentity(idCfg, binary)));
      log('');
    }
    if (n === 1) log('  Reproduce this persona with: --seed <the seed above>\n');
    return 0;
  }

  await launchAll(cfg);
  return null; // sessions own the process lifecycle from here
}

main()
  .then((code) => { if (code !== null && code !== undefined) process.exit(code); })
  .catch((e) => {
    console.error(`\n  Error: ${e.message}\n`);
    if (process.env.SB_DEBUG) console.error(e.stack);
    process.exit(1);
  });
