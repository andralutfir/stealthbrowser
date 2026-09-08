#!/usr/bin/env node
'use strict';
/**
 * Compile app/tailwind.css.
 *
 * Tailwind's Play build is a compiler that runs in a page: give it a document,
 * it emits exactly the utilities that document uses. So this collects every
 * class name the panel and the status page can produce, hands them to that
 * compiler inside the browser this project already knows how to find, and saves
 * what comes back.
 *
 * The result is committed, so nobody who just wants to run the tool needs this:
 * no npm, no build step, and the status page keeps loading with no third-party
 * script inside a disposable session. Run it after changing any class name:
 *
 *     node tools/build-css.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { findBrowser } = require(path.join(ROOT, 'src', 'browser'));
const { CDP, waitForBrowser } = require(path.join(ROOT, 'src', 'cdp'));

const TAILWIND = 'https://cdn.tailwindcss.com/3.4.16';
const OUT = path.join(ROOT, 'app', 'tailwind.css');

/**
 * Compiler settings the pages rely on.
 *
 * `darkMode: 'class'` is the important one: the theme follows a class on <html>
 * rather than the OS setting alone, which is what lets the toggle in each page
 * override it. The animations are named here so a page can ask for
 * `animate-rise` instead of carrying its own keyframes.
 */
const TW_CONFIG = {
  darkMode: 'class',
  theme: {
    extend: {
      keyframes: {
        rise: { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'none' } },
        slidein: { '0%': { opacity: '0', transform: 'translateX(14px)' }, '100%': { opacity: '1', transform: 'none' } },
        pop: { '0%': { opacity: '0', transform: 'scale(.96)' }, '100%': { opacity: '1', transform: 'none' } },
        fade: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
      },
      animation: {
        rise: 'rise .32s cubic-bezier(.22,1,.36,1) both',
        slidein: 'slidein .28s cubic-bezier(.22,1,.36,1) both',
        pop: 'pop .18s cubic-bezier(.22,1,.36,1) both',
        fade: 'fade .25s ease both',
      },
    },
  },
};

/** Files that can contribute a class name, whether in markup or in a string. */
const SOURCES = [
  'app/index.html',
  'app/app.js',
  'app/theme.css',
  'src/statuspage.js',
  'src/statusview.js',
];

/** Drop trailing punctuation a class name cannot end with, brackets included. */
function trimToken(t) {
  let s = t.replace(/^[^a-z[!-]+/i, '').replace(/[,.;:!]+$/, '');
  // `sm:grid-cols-[210px_minmax(0,1fr)]');` arrives with the code around it
  // still attached, so unmatched closers come off from the right.
  for (const [open, close] of [['(', ')'], ['[', ']']]) {
    let guard = 0;
    while (s.endsWith(close) && guard++ < 8) {
      const opens = s.split(open).length - 1;
      const closes = s.split(close).length - 1;
      if (closes <= opens) break;
      s = s.slice(0, -1);
    }
  }
  return s;
}

/**
 * Pull out anything that could be a utility.
 *
 * The whole file is scanned rather than only its string literals: the panel
 * builds most of its markup in JavaScript, and pairing quotes across a file
 * that also contains apostrophes in prose gets it wrong exactly where it
 * matters. Over-collecting is free - a token that is not a Tailwind class
 * compiles to nothing, while a missed one is a visibly broken page.
 */
function collectTokens() {
  const tokens = new Set();
  for (const rel of SOURCES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, 'utf8').split(/[\s"'`;{}<>=]+/)) {
      const t = trimToken(raw.trim());
      if (!t || t.length > 60) continue;
      if (!/^[a-z0-9[\]()/:._,%!#&~+*@-]+$/i.test(t)) continue;
      if (!/[a-z]/i.test(t)) continue;
      tokens.add(t);
    }
  }
  return [...tokens];
}

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'user-agent': 'stealthbrowser-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function main() {
  const tokens = collectTokens();
  console.log(`  ${tokens.length} candidate class names from ${SOURCES.length} files`);

  console.log('  fetching the Tailwind compiler...');
  const compiler = await fetchText(TAILWIND);
  console.log(`  ${(compiler.length / 1024).toFixed(0)} KB`);

  // The compiler reads the document, so the tokens go in as real class
  // attributes rather than as text it would have to be told to look at.
  // The config has to come after the compiler script and before it runs.
  const page = `<!doctype html><html><head><meta charset="utf-8">
<script>${compiler}</script>
<script>tailwind.config = ${JSON.stringify(TW_CONFIG)};</script>
</head><body>
<div class="${tokens.join(' ').replace(/[<>&"]/g, '')}"></div>
</body></html>`;

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const binary = findBrowser('auto', {});
  console.log(`  compiling in ${binary.name}...`);
  const port = await freePort();
  const profile = path.join(os.tmpdir(), `sb-css-${Date.now()}`);
  const child = spawn(binary.path, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    url,
  ], { stdio: 'ignore' });

  let css = '';
  try {
    const info = await waitForBrowser(port);
    const cdp = new CDP(info.webSocketDebuggerUrl);
    await cdp.ready;
    const target = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });

    // Poll until it stops growing: the compiler works through the class list
    // asynchronously, and a stylesheet caught halfway is worse than none.
    let stable = 0;
    for (let i = 0; i < 100 && stable < 3; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const res = await cdp.send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll('style')].map(s => s.textContent).join('\\n')`,
        returnByValue: true,
      }, sessionId);
      const now = (res.result && res.result.value) || '';
      stable = now.length && now.length === css.length ? stable + 1 : 0;
      css = now;
    }
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    server.close();
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 1500);
  }

  if (css.length < 2000) {
    console.error('  The compiler returned almost nothing; leaving the existing file alone.');
    process.exitCode = 1;
    return;
  }

  const header = '/* Generated by tools/build-css.js - do not edit.\n'
    + `   Tailwind ${TAILWIND.split('/').pop()}, ${tokens.length} candidate classes.\n`
    + '   Hand-written rules live in app/theme.css, which the pages load too.\n'
    + '   Re-run after changing any class name: node tools/build-css.js */\n';
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, header + css.trim() + '\n', 'utf8');
  console.log(`  wrote app/tailwind.css (${(css.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error(`  build-css failed: ${e.message}`);
  process.exit(1);
});
