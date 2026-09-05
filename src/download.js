'use strict';
/**
 * Fetch a browser when the machine has none, or when you want a second one.
 *
 * Only browsers that publish a real portable archive are offered. Nothing is
 * installed, no administrator rights are needed and no system setting changes -
 * each browser simply lands in a folder next to this project, and deleting that
 * folder undoes it completely. That matters for a tool whose whole point is
 * leaving no trace.
 *
 * Edge, Vivaldi and Opera ship installers only. Running one would write to
 * Program Files and the registry, so they are reported rather than fetched.
 *
 * Archives are unpacked by the reader below rather than by shelling out, so the
 * project keeps its no-dependency rule on every platform.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { PROJECT_ROOT } = require('./config');

const CFT_VERSIONS = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const SNAPSHOT_BASE = 'https://storage.googleapis.com/chromium-browser-snapshots';
const BRAVE_RELEASES = 'https://api.github.com/repos/brave/brave-browser/releases';

function platformKey() {
  if (process.platform === 'win32') return process.arch === 'ia32' ? 'win32' : 'win64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return 'linux64';
}

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'user-agent': 'stealthbrowser', accept: '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      resolve(res);
    }).on('error', reject);
  });
}

function readAll(res) {
  return new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve(body));
    res.on('error', reject);
  });
}

async function fetchText(url) { return readAll(await get(url)); }
async function fetchJson(url) { return JSON.parse(await fetchText(url)); }

// --------------------------------------------------------------- sources

/**
 * Each source knows how to list what it offers for this platform.
 * `builds()` returns [{ channel, version, url }].
 */
const SOURCES = {
  chrome: {
    name: 'Chrome for Testing',
    note: 'official Google build, versioned',
    async builds() {
      const key = platformKey();
      const data = await fetchJson(CFT_VERSIONS);
      const out = [];
      for (const [channel, ch] of Object.entries(data.channels || {})) {
        const dl = ((ch.downloads && ch.downloads.chrome) || []).find((d) => d.platform === key);
        if (dl) out.push({ channel, version: ch.version, url: dl.url });
      }
      return out;
    },
  },

  chromium: {
    name: 'Chromium',
    note: 'plain upstream build, no Google branding',
    async builds() {
      const dir = { win64: 'Win_x64', win32: 'Win', 'mac-x64': 'Mac', 'mac-arm64': 'Mac_Arm', linux64: 'Linux_x64' }[platformKey()];
      if (!dir) return [];
      const rev = (await fetchText(`${SNAPSHOT_BASE}/${dir}/LAST_CHANGE`)).trim();
      const file = platformKey().startsWith('win') ? 'chrome-win.zip'
        : platformKey().startsWith('mac') ? 'chrome-mac.zip' : 'chrome-linux.zip';
      return [{ channel: 'Snapshot', version: rev, url: `${SNAPSHOT_BASE}/${dir}/${rev}/${file}` }];
    },
  },

  brave: {
    name: 'Brave',
    note: 'portable build from the official GitHub release',
    async builds() {
      const key = platformKey();
      const want = { win64: 'win32-x64', win32: 'win32-ia32', 'mac-x64': 'darwin-x64', 'mac-arm64': 'darwin-arm64' }[key];
      if (!want) return []; // Linux ships packages, not a portable archive.
      const releases = await fetchJson(`${BRAVE_RELEASES}?per_page=12`);
      for (const rel of releases) {
        if (rel.draft) continue;
        const asset = (rel.assets || []).find((a) =>
          // The -symbols archives are debug data, not a browser.
          a.name.startsWith('brave-v') && a.name.includes(want) && a.name.endsWith('.zip') && !a.name.includes('symbols'));
        if (asset) {
          return [{
            channel: rel.prerelease ? 'Beta' : 'Stable',
            version: String(rel.tag_name).replace(/^v/, ''),
            url: asset.browser_download_url,
          }];
        }
      }
      return [];
    },
  },
};

/** Browsers that only ship installers, so this tool will not fetch them. */
const INSTALLER_ONLY = {
  edge: { name: 'Microsoft Edge', url: 'https://www.microsoft.com/edge/download' },
  vivaldi: { name: 'Vivaldi', url: 'https://vivaldi.com/download/' },
  opera: { name: 'Opera', url: 'https://www.opera.com/download' },
};

/** Everything downloadable on this platform, across all sources. */
async function available() {
  const out = [];
  for (const [id, src] of Object.entries(SOURCES)) {
    try {
      for (const b of await src.builds()) out.push({ id, name: src.name, note: src.note, ...b, platform: platformKey() });
    } catch (e) {
      out.push({ id, name: src.name, note: src.note, error: e.message, platform: platformKey() });
    }
  }
  return out;
}

function human(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

async function downloadTo(url, file, onProgress) {
  const res = await get(url);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let done = 0;
    let lastTick = 0;
    res.on('data', (chunk) => {
      done += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 400) { lastTick = now; onProgress(done, total); }
    });
    res.pipe(out);
    out.on('finish', () => { if (onProgress) onProgress(done, total || done); out.close(() => resolve(file)); });
    out.on('error', reject);
    res.on('error', reject);
  });
}

// ------------------------------------------------------------------ unzip

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * Minimal ZIP reader: enough for the store and deflate entries these archives
 * actually use. Encrypted, spanned and ZIP64 archives are rejected rather than
 * half-extracted.
 */
function unzip(zipFile, destDir, onEntry) {
  const buf = fs.readFileSync(zipFile);

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }

  let p = cdOffset;
  let written = 0;
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error('corrupt central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    // The high 16 bits hold the Unix mode when the archive was made on Unix.
    // Chrome for Testing and the Chromium snapshots both set it, and without it
    // the extracted binary comes out unexecutable on Linux and macOS.
    const externalAttrs = buf.readUInt32LE(p + 38);
    const unixMode = (externalAttrs >>> 16) & 0xfff;
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error('encrypted ZIP entries are not supported');

    // Refuse paths that would escape the destination directory.
    const target = path.join(destDir, name);
    const rel = path.relative(destDir, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`unsafe path in archive: ${name}`);

    if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`corrupt entry: ${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported compression method ${method} in ${name}`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    if (process.platform !== 'win32' && unixMode) {
      try { fs.chmodSync(target, unixMode); } catch { /* a mode we cannot set is not fatal */ }
    }
    written++;
    if (onEntry && written % 400 === 0) onEntry(written, entryCount);
  }
  if (onEntry) onEntry(written, entryCount);
  return written;
}

// ------------------------------------------------------------------ install

function installRoot(cfg) {
  const dir = (cfg && cfg.downloadBrowser && cfg.downloadBrowser.dir) || 'browsers';
  return path.isAbsolute(dir) ? dir : path.join(PROJECT_ROOT, dir);
}

const EXE_NAMES = process.platform === 'win32'
  ? ['chrome.exe', 'brave.exe', 'chromium.exe']
  : process.platform === 'darwin'
    ? ['Google Chrome for Testing', 'Brave Browser', 'Chromium']
    : ['chrome', 'brave', 'brave-browser', 'chromium'];

/**
 * Locate the executable inside an unpacked archive.
 * Searched rather than hardcoded: each vendor nests things differently, and a
 * layout change should not silently break the download.
 */
function findExe(dir, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }

  for (const e of entries) {
    if (e.isFile() && EXE_NAMES.includes(e.name)) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findExe(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Browsers this tool has already downloaded. */
function findDownloaded(cfg) {
  const root = installRoot(cfg);
  const found = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.endsWith('.part')) continue;
    const exe = findExe(path.join(root, e.name));
    if (!exe) continue;
    const id = e.name.split('-')[0];
    found.push({
      id: SOURCES[id] ? id : 'downloaded',
      label: SOURCES[id] ? SOURCES[id].name : 'Downloaded browser',
      dir: e.name,
      path: exe,
    });
  }
  return found;
}

/**
 * Download and unpack one browser.
 * @param {object} cfg
 * @param {object} opts { browser, channel, log }
 */
async function install(cfg, opts = {}) {
  const log = opts.log || (() => {});
  const id = String(opts.browser || 'chrome').toLowerCase();

  if (INSTALLER_ONLY[id]) {
    const b = INSTALLER_ONLY[id];
    throw new Error(`${b.name} only ships an installer, which would write to Program Files and the registry. `
      + `Install it yourself from ${b.url} and this tool will find it.`);
  }
  const src = SOURCES[id];
  if (!src) throw new Error(`Unknown browser "${opts.browser}". Try: ${Object.keys(SOURCES).join(', ')}`);

  log(`  Looking up ${src.name}...`);
  const builds = await src.builds();
  if (!builds.length) throw new Error(`${src.name} has no portable build for this platform (${platformKey()})`);

  const wanted = String(opts.channel || (cfg.downloadBrowser && cfg.downloadBrowser.channel) || 'Stable').toLowerCase();
  const build = builds.find((b) => b.channel.toLowerCase() === wanted) || builds[0];

  const root = installRoot(cfg);
  const dirName = `${id}-${build.channel.toLowerCase()}-${build.version}`;
  const target = path.join(root, dirName);

  const already = findDownloaded(cfg).find((f) => f.dir === dirName);
  if (already) { log(`  Already downloaded: ${already.path}`); return already.path; }

  log(`  ${src.name} ${build.channel} ${build.version} (${platformKey()})`);
  fs.mkdirSync(root, { recursive: true });
  const zipFile = path.join(root, `.download-${id}-${Date.now()}.zip`);

  let last = '';
  await downloadTo(build.url, zipFile, (done, total) => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    const line = `  downloading ${human(done)}${total ? ' / ' + human(total) : ''}${total ? '  ' + pct + '%' : ''}`;
    if (line !== last) { last = line; log(line); }
  });

  log('  Unpacking...');
  const tmp = target + '.part';
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    unzip(zipFile, tmp);
    if (!findExe(tmp)) throw new Error('the archive unpacked but no browser executable was found in it');
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(zipFile, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const installed = findDownloaded(cfg).find((f) => f.dir === dirName);
  if (!installed) throw new Error('unpacked, but the executable could not be located afterwards');
  // Belt and braces: an archive built without Unix modes would leave the binary
  // unexecutable, and the failure would only show up at launch.
  if (process.platform !== 'win32') {
    try { fs.chmodSync(installed.path, 0o755); } catch { /* not fatal */ }
  }
  log(`  Ready: ${installed.path}`);
  return installed.path;
}

module.exports = {
  available, install, findDownloaded, installRoot, unzip, human, platformKey,
  SOURCES, INSTALLER_ONLY,
};
