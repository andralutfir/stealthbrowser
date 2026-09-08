'use strict';
/**
 * Local status page shown as the first tab of a session.
 *
 * Served from 127.0.0.1 by the launcher itself, so it loads instantly and needs
 * no network. It shows two columns side by side: what the launcher *configured*
 * and what the browser *actually reports* - which turns it into a live check
 * that the spoofing really landed, not just a summary.
 *
 * The public IP is fetched by the page (not by Node) on purpose: that request
 * travels the exact same path as the browser's normal traffic, so the address
 * shown is the real egress IP, proxy and interface binding included.
 *
 * Styling is the stylesheet built by tools/build-css.js, served from disk. No
 * CDN, no third-party script: a page that opens inside a disposable session
 * should not make a request nobody asked for.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { PROJECT_ROOT } = require('./config');

const CSS_FILE = path.join(PROJECT_ROOT, 'app', 'tailwind.css');

/*
 * The quality band picks its colour at runtime, so those class names never
 * appear whole in the source and the stylesheet builder cannot see them.
 * Spelling them out once here is what keeps the score from rendering colourless:
 *   text-emerald-400 text-amber-400 text-rose-400 text-zinc-500
 *   bg-emerald-400 bg-amber-400 bg-rose-400
 *   bg-emerald-500/15 bg-amber-500/15 bg-rose-500/15
 */

/**
 * Address classification, no API key needed. `proxy`, `hosting` and `mobile`
 * are the flags the score is built from; `reverse` costs the service a PTR
 * lookup, so it is asked for explicitly.
 *
 * Plain HTTP because that is what the free tier serves - the status page is
 * itself local HTTP, so nothing is downgraded. Only the classification travels
 * that way, and it travels the session's own proxy like every other request.
 */
const DEFAULT_QUALITY_SERVICE = 'http://ip-api.com/json/?fields=status,message,country,'
  + 'countryCode,city,timezone,isp,org,as,reverse,mobile,proxy,hosting,query';

/** Runs in the page: measures what a real website would see. */
function pageScript(DATA) {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '-' : s);

  const CELL_K = 'w-[38%] py-2 pl-5 pr-3 align-top text-zinc-400';
  const CELL_V = 'py-2 pr-5 align-top tabular-nums break-words';
  const MONO = ' font-mono text-[13px]';
  const PILL = 'ml-1 inline-block rounded-full px-2 py-0.5 text-[12px] font-semibold ';
  const P_OK = PILL + 'bg-emerald-500/15 text-emerald-400';
  const P_BAD = PILL + 'bg-rose-500/15 text-rose-400';
  const P_WARN = PILL + 'bg-amber-500/15 text-amber-400';

  const gl = (() => {
    try {
      const c = document.createElement('canvas').getContext('webgl');
      const d = c && c.getExtension('WEBGL_debug_renderer_info');
      return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null;
    } catch (e) { return null; }
  })();

  const canvasHash = (() => {
    try {
      const c = document.createElement('canvas');
      c.width = 200; c.height = 50;
      const x = c.getContext('2d');
      x.textBaseline = 'top'; x.font = '16px Arial';
      x.fillStyle = '#f60'; x.fillRect(0, 0, 100, 25);
      x.fillStyle = '#069'; x.fillText('sb-©', 2, 15);
      const s = c.toDataURL();
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
      return (h >>> 0).toString(16);
    } catch (e) { return '-'; }
  })();

  const seen = {
    ua: navigator.userAgent,
    platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform,
    locale: navigator.language,
    languages: navigator.languages.join(', '),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset: -new Date().getTimezoneOffset() / 60,
    screen: screen.width + 'x' + screen.height + ' @' + devicePixelRatio + 'x',
    window: innerWidth + 'x' + innerHeight,
    cores: navigator.hardwareConcurrency,
    memory: navigator.deviceMemory ? navigator.deviceMemory + ' GB' : '-',
    gpu: gl,
    canvas: canvasHash,
    webdriver: String(navigator.webdriver),
    cookies: document.cookie ? document.cookie.split(';').length : 0,
  };

  const row = (k, v, mono) =>
    `<tr class="border-b border-zinc-800 last:border-0"><td class="${CELL_K}">${k}</td>`
    + `<td class="${CELL_V}${mono ? MONO : ''}">${esc(v)}</td></tr>`;

  $('set').innerHTML = [
    row('User-Agent', DATA.identity.userAgent, true),
    row('Platform', DATA.identity.chPlatform + ' ' + DATA.identity.platformVersion),
    row('Languages', DATA.identity.languages.join(', ')),
    row('Timezone', DATA.identity.timezone),
    row('Screen', DATA.identity.screen.width + 'x' + DATA.identity.screen.height + ' @' + DATA.identity.screen.dpr + 'x'),
    row('CPU / RAM', DATA.identity.cores + ' cores / ' + DATA.identity.memory + ' GB'),
    row('GPU', DATA.identity.gpu),
    row('Geolocation', DATA.identity.geo),
    row('Seed', DATA.identity.seed, true),
  ].join('');

  const cmp = (a, b) => {
    const A = String(a).toLowerCase(), B = String(b).toLowerCase();
    return A === B || A.indexOf(B) !== -1 || B.indexOf(A) !== -1;
  };
  // Failures are collected as they are drawn, so the simple view can name them
  // instead of asking the reader to scan a table for a red pill.
  const problems = [];
  const mark = (okFlag, label) => {
    if (!okFlag && label) problems.push(label);
    return `<span class="${okFlag ? P_OK : P_BAD}">${okFlag ? 'match' : 'MISMATCH'}</span>`;
  };

  $('seen').innerHTML = [
    row('User-Agent', seen.ua, true),
    row('Platform', seen.platform + ' ' + mark(cmp(seen.platform, DATA.identity.chPlatform), 'platform')),
    row('Languages', seen.languages + ' ' + mark(cmp(seen.locale, DATA.identity.languages[0]), 'languages')),
    row('Timezone', seen.timezone + ' (UTC' + (seen.offset >= 0 ? '+' : '') + seen.offset + ') ' + mark(cmp(seen.timezone, DATA.identity.timezone), 'timezone')),
    row('Screen', seen.screen + ' ' + mark(seen.screen.indexOf(DATA.identity.screen.width + 'x' + DATA.identity.screen.height) === 0, 'screen size')),
    row('Window', seen.window),
    row('CPU / RAM', seen.cores + ' cores / ' + seen.memory + ' ' + mark(String(seen.cores) === String(DATA.identity.cores), 'CPU cores')),
    row('GPU', (seen.gpu || '-') + ' ' + mark(cmp(seen.gpu || '', DATA.identity.gpu), 'GPU')),
    row('Canvas hash', seen.canvas, true),
    row('navigator.webdriver', seen.webdriver + ' ' + mark(seen.webdriver === 'false', 'navigator.webdriver')),
    row('Cookies stored', seen.cookies + ' ' + mark(seen.cookies === 0, 'leftover cookies')),
  ].join('');

  // ---- simple view --------------------------------------------------------
  //
  // The same session in sentences. Nothing here is a second source of truth:
  // every line is built from the values the advanced tables already show.
  let ipPlace = null;      // "Jakarta, Indonesia" once the lookup lands
  let ipZone = null;       // the timezone that address belongs to
  let quality = null;      // { score, band, label }

  const brand = (() => {
    const m = seen.ua.match(/(Edg|Chrome|Firefox)\/(\d+)/);
    if (!m) return 'a Chromium browser';
    return (m[1] === 'Edg' ? 'Edge' : m[1]) + ' ' + m[2];
  })();
  const osName = /Windows/i.test(seen.ua) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(seen.ua) ? 'macOS'
      : /Android/i.test(seen.ua) ? 'Android'
        : /Linux|X11/i.test(seen.ua) ? 'Linux' : String(seen.platform);
  const langName = (() => {
    try { return new Intl.DisplayNames([seen.locale], { type: 'language' }).of(seen.locale.split('-')[0]); }
    catch (e) { return seen.locale; }
  })();

  const prow = (k, v, why) =>
    `<tr class="border-b border-zinc-800 last:border-0">`
    + `<td class="w-[34%] py-3 pl-5 pr-3 align-top text-zinc-400">${k}</td>`
    + `<td class="py-3 pr-5 align-top">${esc(v)}`
    + (why ? `<span class="mt-1 block text-[13px] text-zinc-500">${why}</span>` : '')
    + '</td></tr>';

  function drawSimple() {
    const tzClash = ipZone && ipZone !== seen.timezone;
    $('plain').innerHTML = [
      prow('Websites see you as', brand + ' on ' + osName,
        'Your real browser and its version are not what is being sent.'),
      prow('Your language looks like', langName + ' (' + seen.locale + ')'),
      prow('Your clock looks like', seen.timezone,
        tzClash ? 'Your connection is in ' + ipZone + '. A site comparing the two will notice.' : null),
      prow('Your connection comes from', ipPlace || 'checking…'),
      prow('Going out through', DATA.network + (DATA.proxy ? ' via ' + DATA.proxy : ', no proxy')),
      prow('Address quality', quality ? quality.score + '% — ' + quality.label : 'checking…',
        quality && quality.score < 100 ? 'See the breakdown above for what cost points.' : null),
      prow('Data saving', DATA.bandwidth),
      prow('Cookies carried in', seen.cookies === 0 ? 'none, this profile is brand new'
        : seen.cookies + ' — unexpected for a fresh profile'),
      prow('When you close it', 'The profile is deleted. No history, no cookies, no cache left behind.'),
    ].join('');

    const issues = problems.slice();
    if (tzClash) issues.push('clock vs connection country');
    if (quality && quality.score < 65) issues.push('address quality ' + quality.score + '%');

    const dot = $('verdict-dot');
    const title = $('verdict-title');
    const detail = $('verdict-detail');
    if (!issues.length) {
      dot.className = 'mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-400';
      title.textContent = 'Everything checks out';
      detail.textContent = 'The identity landed, nothing was carried over from a previous session, '
        + 'and the connection matches what sites will be told.';
    } else {
      const bad = issues.length > 2 || problems.length > 1;
      dot.className = 'mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ' + (bad ? 'bg-rose-400' : 'bg-amber-400');
      title.textContent = issues.length + (issues.length === 1 ? ' thing to look at' : ' things to look at');
      detail.textContent = issues.join(' · ') + '. Switch to Advanced for the detail.';
    }
  }

  const ON = 'bg-indigo-500 text-white';
  const OFF = 'text-zinc-400 hover:text-zinc-100';
  const setMode = (m) => {
    const simple = m === 'simple';
    for (const node of document.querySelectorAll('.simple-only')) node.classList.toggle('hidden', !simple);
    for (const node of document.querySelectorAll('.adv-only')) node.classList.toggle('hidden', simple);
    $('m-simple').className = 'px-4 py-2 text-[13px] font-semibold ' + (simple ? ON : OFF);
    $('m-advanced').className = 'px-4 py-2 text-[13px] font-semibold ' + (simple ? OFF : ON);
  };
  $('m-simple').onclick = () => setMode('simple');
  $('m-advanced').onclick = () => setMode('advanced');
  setMode(DATA.mode === 'simple' ? 'simple' : 'advanced');

  $('sess').innerHTML = [
    row('Browser', DATA.browser),
    row('Connection', DATA.network),
    row('Proxy', DATA.proxy || 'not used'),
    row('Bandwidth mode', DATA.bandwidth),
    row('Profile', DATA.profile, true),
    row('Started', DATA.time),
  ].join('');

  drawSimple();

  // The IP lookup goes through the browser's own network path, so it reflects
  // the interface binding and proxy that this session is actually using.
  if (!DATA.checkIp) {
    $('ipval').textContent = 'disabled';
    $('ipnote').textContent = 'statusPage.checkIp = false';
    ipPlace = 'not looked up';
    drawSimple();
    return;
  }

  let ipResolved = false;
  const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
  const ask = (url) => Promise.race([
    fetch(url, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }),
    timeout(7000),
  ]);

  // The primary service may add city/ISP but is more likely to rate-limit;
  // the fallback only returns an address but practically never fails.
  ask(DATA.ipService)
    .catch(() => (DATA.ipFallback ? ask(DATA.ipFallback) : Promise.reject(new Error('no fallback configured'))))
    .then((j) => {
      ipResolved = true;
      $('ipval').textContent = j.ip || j.query || j.origin || '-';
      $('ipval').classList.remove('text-rose-400');
      const bits = [j.city, j.region, j.country || j.country_name].filter(Boolean);
      $('ipgeo').textContent = bits.length ? bits.join(', ') : 'not reported';
      $('ipnote').textContent = j.org || j.asn || 'via this session network path';
      ipPlace = bits.length ? bits.join(', ') : 'not reported';
      drawSimple();
    })
    .catch((e) => {
      $('ipval').textContent = 'failed';
      $('ipval').classList.add('text-rose-400');
      $('ipnote').textContent = 'could not reach the IP service (' + e.message + ')';
      ipPlace = 'could not be checked';
      drawSimple();
    });

  // ---- how a website is likely to judge this address ----------------------
  //
  // Every deduction below is something the service actually reported, and the
  // page shows each one with the weight it carried. A number nobody can take
  // apart is worth nothing, so there is no hidden term in the total.
  if (!DATA.checkQuality) { quality = null; drawSimple(); return; }

  const qnote = (t) => { $('qnote').textContent = t; };

  ask(DATA.qualityService).then((q) => {
    if (q.status && q.status !== 'success') throw new Error(q.message || q.status);

    // Field names follow ip-api.com; the aliases cover the services that use
    // the other common spelling for the same flag.
    const isProxy = !!(q.proxy || q.vpn || q.tor);
    const isHosting = !!(q.hosting || q.datacenter);
    const isMobile = !!q.mobile;
    const ipTz = q.timezone || '';
    const tzKnown = !!ipTz && !!seen.timezone;
    const tzMatch = tzKnown && ipTz === seen.timezone;

    // The card header above already names the address and its network - unless
    // the IP service failed, in which case this lookup fills those in rather
    // than leaving three dashes next to a working score.
    if (!ipResolved) {
      if (q.query) { $('ipval').textContent = q.query; $('ipval').classList.remove('text-rose-400'); }
      const bits = [q.city, q.country].filter(Boolean);
      if (bits.length) $('ipgeo').textContent = bits.join(', ');
      $('ipnote').textContent = q.isp || q.org || q.as || 'via this session network path';
    }

    const checks = [];
    const add = (label, value, cost, good) => checks.push({ label, value, cost, good });

    add('Address type',
      isProxy ? 'proxy, VPN or Tor exit' : isHosting ? 'datacenter / hosting range' : 'residential or business ISP',
      isProxy ? 50 : isHosting ? 35 : 0,
      !isProxy && !isHosting);
    if (isMobile) add('Carrier', 'mobile, shared behind CGNAT', 5, false);
    if (q.reverse) add('Reverse DNS', q.reverse, 0, true);
    if (tzKnown) {
      add('Browser timezone vs IP', tzMatch ? seen.timezone + ' = ' + ipTz : seen.timezone + ' vs ' + ipTz,
        tzMatch ? 0 : 15, tzMatch);
    }

    let score = 100;
    for (const c of checks) score -= c.cost;
    score = Math.max(0, Math.min(100, score));

    const band = score >= 85 ? { t: 'clean', c: 'emerald' }
      : score >= 65 ? { t: 'usable', c: 'emerald' }
        : score >= 40 ? { t: 'questionable', c: 'amber' }
          : { t: 'poor', c: 'rose' };

    ipZone = ipTz || null;
    quality = { score, band: band.c, label: band.t };
    if (!ipPlace) { const b = [q.city, q.country].filter(Boolean); if (b.length) ipPlace = b.join(', '); }
    drawSimple();

    $('qscore').textContent = score + '%';
    $('qscore').className = 'text-3xl font-semibold tabular-nums tracking-tight text-' + band.c + '-400';
    $('qlabel').className = PILL + 'bg-' + band.c + '-500/15 text-' + band.c + '-400 align-middle';
    $('qlabel').textContent = band.t;
    $('qbar').className = 'h-full rounded-full bg-' + band.c + '-400 transition-all duration-500';
    $('qbar').style.width = score + '%';

    $('qrows').innerHTML = checks.map((c) => {
      const pill = c.cost > 0
        ? `<span class="${c.cost >= 30 ? P_BAD : P_WARN}">&minus;${c.cost}</span>`
        : c.good ? `<span class="${P_OK}">ok</span>` : '';
      return '<tr class="border-b border-zinc-800 last:border-0">'
        + `<td class="${CELL_K}">${c.label}</td>`
        + `<td class="${CELL_V}">${esc(c.value)}</td>`
        + `<td class="w-24 py-2 pr-5 text-right align-top">${pill}</td></tr>`;
    }).join('');

    qnote('Starts at 100 and subtracts what the lookup reported. This is how the address itself '
      + 'classifies, not a fraud-score subscription - a site running its own scoring can disagree. '
      + 'Source: ' + DATA.qualityService.replace(/^https?:\/\//, '').split('/')[0]);
  }).catch((e) => {
    $('qscore').textContent = 'n/a';
    $('qscore').className = 'text-3xl font-semibold tracking-tight text-zinc-500';
    qnote('Quality lookup unavailable (' + e.message + '). No score is shown rather than a guessed one.');
    quality = null;
    drawSimple();
  });
}

function renderHtml(data, base) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const card = 'rounded-xl border border-zinc-800 bg-zinc-900/40';
  const h2 = 'px-5 pt-4 text-[12px] font-semibold uppercase tracking-wider text-zinc-500';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session ${data.tag || 'stealthbrowser'}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%236366f1'/%3E%3Ccircle cx='8' cy='8' r='3' fill='%23fff'/%3E%3C/svg%3E">
<link rel="stylesheet" href="${base}tailwind.css">
</head>
<body class="bg-zinc-950 text-zinc-100 antialiased">
<div class="mx-auto max-w-5xl px-6 py-8">

  <div class="mb-6 flex flex-wrap items-start gap-4">
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold tracking-tight">New session ready${data.tag ? ' &mdash; ' + data.tag : ''}</h1>
      <p class="mt-1 text-[15px] text-zinc-400">Disposable profile. The identity below applies to this session only
        and changes the next time the browser opens.</p>
    </div>
    <div class="ml-auto flex shrink-0 overflow-hidden rounded-lg border border-zinc-700">
      <button type="button" id="m-simple" class="px-4 py-2 text-[13px] font-semibold text-zinc-400 hover:text-zinc-100">Simple</button>
      <button type="button" id="m-advanced" class="px-4 py-2 text-[13px] font-semibold text-zinc-400 hover:text-zinc-100">Advanced</button>
    </div>
  </div>

  <div class="simple-only mb-4 flex items-start gap-3 ${card} px-5 py-4">
    <span id="verdict-dot" class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-zinc-600"></span>
    <div>
      <b id="verdict-title" class="block text-[17px] font-semibold">Checking&hellip;</b>
      <span id="verdict-detail" class="text-[14px] text-zinc-400">Reading what this session actually reports.</span>
    </div>
  </div>

  <div class="mb-4 ${card} px-5 py-4">
    <div class="flex flex-wrap items-baseline gap-x-8 gap-y-4">
      <div>
        <span class="mb-1 block text-[12px] font-semibold uppercase tracking-wider text-zinc-500">Current public IP</span>
        <b id="ipval" class="text-3xl font-semibold tabular-nums tracking-tight">loading&hellip;</b>
      </div>
      <div>
        <span class="mb-1 block text-[12px] font-semibold uppercase tracking-wider text-zinc-500">Location</span>
        <span id="ipgeo" class="text-[15px] text-zinc-400">&mdash;</span>
      </div>
      <div>
        <span class="mb-1 block text-[12px] font-semibold uppercase tracking-wider text-zinc-500">Network</span>
        <span id="ipnote" class="text-[15px] text-zinc-400">&mdash;</span>
      </div>
${data.checkQuality ? `      <div class="ml-auto text-right">
        <span class="mb-1 block text-[12px] font-semibold uppercase tracking-wider text-zinc-500">IP quality</span>
        <b id="qscore" class="text-3xl font-semibold tabular-nums tracking-tight">checking&hellip;</b>
        <span id="qlabel"></span>
      </div>` : ''}
    </div>
${data.checkQuality ? `    <div class="mt-4 border-t border-zinc-800 pt-3">
      <div class="mb-2 h-2 overflow-hidden rounded-full bg-zinc-800">
        <div id="qbar" class="h-full w-0 rounded-full bg-zinc-600"></div>
      </div>
      <table class="w-full text-[15px]"><tbody id="qrows"></tbody></table>
      <p id="qnote" class="mt-2 text-[13px] leading-relaxed text-zinc-500">Asking the lookup service what this address looks like&hellip;</p>
    </div>` : ''}
  </div>

  <div class="simple-only ${card} pb-3">
    <h2 class="${h2}">In plain words</h2>
    <table class="w-full px-5 text-[15px]"><tbody id="plain"></tbody></table>
  </div>

  <div class="adv-only ${card} pb-3">
    <h2 class="${h2}">Session</h2>
    <table class="w-full text-[15px]"><tbody id="sess"></tbody></table>
  </div>

  <div class="adv-only mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
    <div class="${card} pb-3">
      <h2 class="${h2}">Identity applied</h2>
      <table class="w-full text-[15px]"><tbody id="set"></tbody></table>
    </div>
    <div class="${card} pb-3">
      <h2 class="${h2}">What websites actually see</h2>
      <table class="w-full text-[15px]"><tbody id="seen"></tbody></table>
    </div>
  </div>

  <p class="adv-only mt-4 text-[14px] text-zinc-500">
    Test further:
    <a class="ml-3 text-indigo-400 hover:underline" href="https://abrahamjuliot.github.io/creepjs/" target="_blank" rel="noreferrer">CreepJS</a>
    <a class="ml-3 text-indigo-400 hover:underline" href="https://browserleaks.com/webrtc" target="_blank" rel="noreferrer">WebRTC leak</a>
    <a class="ml-3 text-indigo-400 hover:underline" href="https://www.dnsleaktest.com/" target="_blank" rel="noreferrer">DNS leak</a>
  </p>
</div>
<script>(${pageScript.toString()})(${json});</script>
</body></html>`;
}

class StatusPage {
  /**
   * @param {object} opts { identity, profile, iface, upstream, browser, tag, checkIp, ipService }
   */
  constructor(opts) {
    this.opts = opts;
    // A random path keeps the page from being trivially reachable by anything
    // else that happens to be poking at localhost.
    this.token = crypto.randomBytes(9).toString('hex');
    const html = renderHtml(this._data(), `/${this.token}/`);
    this.server = http.createServer((req, res) => {
      const url = (req.url || '').split('?')[0];
      if (url === `/${this.token}/tailwind.css`) {
        fs.readFile(CSS_FILE, (err, buf) => {
          if (err) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('app/tailwind.css is missing - run: node tools/build-css.js');
            return;
          }
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
          res.end(buf);
        });
        return;
      }
      if (url !== `/${this.token}/` && url !== `/${this.token}`) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // Nothing here should ever be readable by another origin.
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(html);
    });
    this.server.on('clientError', (_err, sock) => { try { sock.destroy(); } catch {} });
  }

  _data() {
    const o = this.opts;
    const id = o.identity;
    return {
      tag: o.tag || '',
      browser: `${o.browser.name} ${o.browser.version || ''}`.trim(),
      network: o.iface ? `${o.iface.name} (${o.iface.address})` : 'default route',
      proxy: o.upstream ? o.upstream.label : null,
      bandwidth: o.bandwidth || 'off',
      profile: o.profile.dir,
      time: new Date().toLocaleString('en-GB'),
      mode: o.mode === 'simple' ? 'simple' : 'advanced',
      checkIp: o.checkIp !== false,
      ipService: o.ipService || 'https://ipinfo.io/json',
      ipFallback: o.ipFallback || 'https://api.ipify.org?format=json',
      checkQuality: o.checkIp !== false && o.checkQuality !== false,
      qualityService: o.qualityService || DEFAULT_QUALITY_SERVICE,
      identity: {
        seed: id.seed,
        userAgent: id.userAgent,
        chPlatform: id.chPlatform,
        platformVersion: id.platformVersion,
        languages: id.languages,
        timezone: id.timezone,
        screen: { width: id.screen.width, height: id.screen.height, dpr: id.screen.dpr },
        cores: id.hardwareConcurrency,
        memory: id.deviceMemory,
        gpu: id.webgl.renderer,
        geo: `${id.geo.latitude.toFixed(3)}, ${id.geo.longitude.toFixed(3)}`,
      },
    };
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.url = `http://127.0.0.1:${this.port}/${this.token}/`;
        resolve(this.url);
      });
    });
  }

  close() { try { this.server.close(); } catch {} }
}

module.exports = { StatusPage };
