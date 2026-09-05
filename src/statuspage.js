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
 */
const http = require('http');
const crypto = require('crypto');

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

const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#14161a;--dim:#6b7280;
--line:#e3e6ea;--ok:#0a7d32;--warn:#a15c00;--bad:#b42318;--accent:#2f6feb}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--fg:#e6e8ec;
--dim:#9aa1ac;--line:#252932;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--accent:#6ea8fe}}
*{box-sizing:border-box}
body{margin:0;padding:26px 24px 32px;background:var(--bg);color:var(--fg);
font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1120px;margin:0 auto}
h1{font-size:22px;margin:0 0 3px;font-weight:650;letter-spacing:-.2px}
.sub{color:var(--dim);font-size:14px;margin-bottom:20px}
.top{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.top .sub{margin-bottom:0}
.modes{margin-left:auto;display:flex;gap:0;border:1px solid var(--line);
border-radius:8px;overflow:hidden;background:var(--card);flex:none}
.modes button{appearance:none;border:0;background:transparent;color:var(--dim);
font:600 13.5px/1 inherit;padding:9px 16px;cursor:pointer}
.modes button.on{background:var(--accent);color:#fff}
.modes button:not(.on):hover{color:var(--fg)}
.ip{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:16px 18px 14px;margin-bottom:14px}
.ipmain{display:flex;flex-wrap:wrap;gap:18px 26px;align-items:baseline}
.ipmain b{font-size:30px;font-weight:650;letter-spacing:-.3px;font-variant-numeric:tabular-nums}
.ip .lbl{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.6px;
display:block;margin-bottom:4px}
.ipmain>div{font-size:15.5px}
.qspot{margin-left:auto;text-align:right}
.qspot .pill{vertical-align:4px;margin-left:6px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:760px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px 18px 14px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);
margin:14px 0 9px;font-weight:600}
table{width:100%;border-collapse:collapse}
td{padding:7px 0;vertical-align:top;border-bottom:1px solid var(--line);font-size:14.5px}
tr:last-child td{border-bottom:0}
td.k{color:var(--dim);width:38%;padding-right:12px;white-space:nowrap}
td.v{word-break:break-word;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13.5px}
.pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:12.5px;font-weight:600}
.p-ok{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}
.p-bad{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}
.p-warn{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn)}
.links{margin-top:16px;font-size:14px;color:var(--dim)}
.links a{color:var(--accent);text-decoration:none;margin-right:14px}
.links a:hover{text-decoration:underline}
.muted{color:var(--dim)}
.qwrap{border-top:1px solid var(--line);margin-top:14px;padding-top:12px}
.qbarwrap{height:8px;border-radius:6px;overflow:hidden;margin-bottom:8px;
background:color-mix(in srgb,var(--fg) 10%,transparent)}
.qbar{height:100%;width:0;border-radius:6px;transition:width .55s ease}
.qnote{color:var(--dim);font-size:13px;margin-top:10px;line-height:1.5}
td.n{text-align:right;white-space:nowrap;width:82px;color:var(--dim);
font-variant-numeric:tabular-nums;font-size:13px}

/* Simple view: the same session, said in sentences instead of fields. */
.simple .adv-only{display:none}
.advanced .simple-only{display:none}
.verdict{border-radius:10px;padding:15px 18px;margin-bottom:14px;font-size:16px;
border:1px solid var(--line);background:var(--card);display:flex;gap:13px;align-items:flex-start}
.verdict .dot{width:11px;height:11px;border-radius:50%;flex:none;margin-top:6px}
.verdict b{display:block;font-size:17.5px;font-weight:650;margin-bottom:2px}
.verdict span{color:var(--dim);font-size:14.5px}
.v-ok .dot{background:var(--ok)} .v-warn .dot{background:var(--warn)} .v-bad .dot{background:var(--bad)}
.plain td{font-size:15.5px;padding:10px 0}
.plain td.k{width:34%;color:var(--dim)}
.plain .why{display:block;color:var(--dim);font-size:13.5px;margin-top:2px}
`;

/** Runs in the page: measures what a real website would see. */
function pageScript(DATA) {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '-' : s);

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

  const row = (k, v, cls) => `<tr><td class="k">${k}</td><td class="v ${cls || ''}">${esc(v)}</td></tr>`;

  $('set').innerHTML = [
    row('User-Agent', DATA.identity.userAgent, 'mono'),
    row('Platform', DATA.identity.chPlatform + ' ' + DATA.identity.platformVersion),
    row('Languages', DATA.identity.languages.join(', ')),
    row('Timezone', DATA.identity.timezone),
    row('Screen', DATA.identity.screen.width + 'x' + DATA.identity.screen.height + ' @' + DATA.identity.screen.dpr + 'x'),
    row('CPU / RAM', DATA.identity.cores + ' cores / ' + DATA.identity.memory + ' GB'),
    row('GPU', DATA.identity.gpu),
    row('Geolocation', DATA.identity.geo),
    row('Seed', DATA.identity.seed, 'mono'),
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
    return `<span class="pill ${okFlag ? 'p-ok' : 'p-bad'}">${okFlag ? 'match' : 'MISMATCH'}</span>`;
  };

  $('seen').innerHTML = [
    row('User-Agent', seen.ua, 'mono'),
    row('Platform', seen.platform + ' ' + mark(cmp(seen.platform, DATA.identity.chPlatform), 'platform')),
    row('Languages', seen.languages + ' ' + mark(cmp(seen.locale, DATA.identity.languages[0]), 'languages')),
    row('Timezone', seen.timezone + ' (UTC' + (seen.offset >= 0 ? '+' : '') + seen.offset + ') ' + mark(cmp(seen.timezone, DATA.identity.timezone), 'timezone')),
    row('Screen', seen.screen + ' ' + mark(seen.screen.indexOf(DATA.identity.screen.width + 'x' + DATA.identity.screen.height) === 0, 'screen size')),
    row('Window', seen.window),
    row('CPU / RAM', seen.cores + ' cores / ' + seen.memory + ' ' + mark(String(seen.cores) === String(DATA.identity.cores), 'CPU cores')),
    row('GPU', (seen.gpu || '-') + ' ' + mark(cmp(seen.gpu || '', DATA.identity.gpu), 'GPU')),
    row('Canvas hash', seen.canvas, 'mono'),
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

  const prow = (k, v, why) => `<tr><td class="k">${k}</td><td class="v">${esc(v)}`
    + (why ? `<span class="why">${why}</span>` : '') + '</td></tr>';

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

    const v = $('verdict');
    if (!issues.length) {
      v.className = 'verdict simple-only v-ok';
      v.innerHTML = '<span class="dot"></span><div><b>Everything checks out</b>'
        + '<span>The identity landed, nothing was carried over from a previous session, '
        + 'and the connection matches what sites will be told.</span></div>';
    } else {
      const bad = issues.length > 2 || problems.length > 1;
      v.className = 'verdict simple-only ' + (bad ? 'v-bad' : 'v-warn');
      v.innerHTML = '<span class="dot"></span><div><b>' + issues.length
        + (issues.length === 1 ? ' thing to look at' : ' things to look at') + '</b>'
        + '<span>' + issues.join(' · ') + '. Switch to Advanced for the detail.</span></div>';
    }
  }

  const setMode = (m) => {
    document.body.className = m;
    $('m-simple').className = m === 'simple' ? 'on' : '';
    $('m-advanced').className = m === 'advanced' ? 'on' : '';
  };
  $('m-simple').onclick = () => setMode('simple');
  $('m-advanced').onclick = () => setMode('advanced');
  setMode(DATA.mode === 'simple' ? 'simple' : 'advanced');

  $('sess').innerHTML = [
    row('Browser', DATA.browser),
    row('Connection', DATA.network),
    row('Proxy', DATA.proxy || 'not used'),
    row('Bandwidth mode', DATA.bandwidth),
    row('Profile', DATA.profile, 'mono muted'),
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
      $('ipval').style.color = '';
      const bits = [j.city, j.region, j.country || j.country_name].filter(Boolean);
      $('ipgeo').textContent = bits.length ? bits.join(', ') : 'not reported';
      $('ipnote').textContent = j.org || j.asn || 'via this session network path';
      ipPlace = bits.length ? bits.join(', ') : 'not reported';
      drawSimple();
    })
    .catch((e) => {
      $('ipval').textContent = 'failed';
      $('ipval').style.color = 'var(--bad)';
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
  const qfail = (msg) => {
    $('qscore').textContent = 'n/a';
    $('qscore').style.color = 'var(--dim)';
    qnote(msg);
  };

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

    const checks = [];
    const add = (label, value, cost, good) => {
      checks.push({ label: label, value: value, cost: cost, good: good });
    };

    // The card header above already names the address and its network - unless
    // the IP service failed, in which case this lookup fills those in rather
    // than leaving three dashes next to a working score.
    if (!ipResolved) {
      if (q.query) { $('ipval').textContent = q.query; $('ipval').style.color = ''; }
      const bits = [q.city, q.country].filter(Boolean);
      if (bits.length) $('ipgeo').textContent = bits.join(', ');
      $('ipnote').textContent = q.isp || q.org || q.as || 'via this session network path';
    }

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

    const band = score >= 85 ? { t: 'clean', c: 'ok' }
      : score >= 65 ? { t: 'usable', c: 'ok' }
        : score >= 40 ? { t: 'questionable', c: 'warn' }
          : { t: 'poor', c: 'bad' };

    $('qscore').textContent = score + '%';
    $('qscore').style.color = 'var(--' + band.c + ')';
    $('qlabel').className = 'pill p-' + band.c;
    $('qlabel').textContent = band.t;
    $('qbar').style.width = score + '%';
    $('qbar').style.background = 'var(--' + band.c + ')';

    $('qrows').innerHTML = checks.map((c) => {
      const pill = c.cost > 0
        ? '<span class="pill p-' + (c.cost >= 30 ? 'bad' : 'warn') + '">&minus;' + c.cost + '</span>'
        : c.good ? '<span class="pill p-ok">ok</span>' : '';
      return '<tr><td class="k">' + c.label + '</td><td class="v">' + esc(c.value)
        + '</td><td class="n">' + pill + '</td></tr>';
    }).join('');

    ipZone = ipTz || null;
    quality = { score: score, band: band.c, label: band.t };
    if (!ipPlace) { const b = [q.city, q.country].filter(Boolean); if (b.length) ipPlace = b.join(', '); }
    drawSimple();

    qnote('Starts at 100 and subtracts what the lookup reported. This is how the address itself '
      + 'classifies, not a fraud-score subscription - a site running its own scoring can disagree. '
      + 'Source: ' + DATA.qualityService.replace(/^https?:\/\//, '').split('/')[0]);
  }).catch((e) => {
    qfail('Quality lookup unavailable (' + e.message + '). No score is shown rather than a guessed one.');
    quality = null;
    drawSimple();
  });
}

function renderHtml(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session ${data.tag || 'stealthbrowser'}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%232f6feb'/%3E%3Ccircle cx='8' cy='8' r='3' fill='%23fff'/%3E%3C/svg%3E">
<style>${PAGE_CSS}</style></head>
<body class="advanced"><div class="wrap">
<div class="top">
  <div>
    <h1>New session ready${data.tag ? ' &mdash; ' + data.tag : ''}</h1>
    <div class="sub">Disposable profile. The identity below applies to this session only and changes the next time the browser opens.</div>
  </div>
  <div class="modes">
    <button type="button" id="m-simple">Simple</button>
    <button type="button" id="m-advanced">Advanced</button>
  </div>
</div>

<div class="verdict simple-only" id="verdict"><span class="dot"></span><div><b>Checking&hellip;</b><span>Reading what this session actually reports.</span></div></div>

<div class="ip">
  <div class="ipmain">
    <div><span class="lbl">Current public IP</span><b id="ipval">loading&hellip;</b></div>
    <div><span class="lbl">Location</span><span id="ipgeo" class="muted">&mdash;</span></div>
    <div><span class="lbl">Network</span><span id="ipnote" class="muted">&mdash;</span></div>
${data.checkQuality ? `    <div class="qspot"><span class="lbl">IP quality</span><b id="qscore">checking&hellip;</b><span id="qlabel"></span></div>` : ''}
  </div>
${data.checkQuality ? `  <div class="qwrap">
    <div class="qbarwrap"><div class="qbar" id="qbar"></div></div>
    <table id="qrows"></table>
    <div class="qnote" id="qnote">Asking the lookup service what this address looks like&hellip;</div>
  </div>` : ''}
</div>

<div class="card simple-only"><h2>In plain words</h2><table class="plain" id="plain"></table></div>

<div class="card adv-only"><h2>Session</h2><table id="sess"></table></div>

<div class="grid adv-only" style="margin-top:14px">
  <div class="card"><h2>Identity applied</h2><table id="set"></table></div>
  <div class="card"><h2>What websites actually see</h2><table id="seen"></table></div>
</div>

<div class="links adv-only">
  Test further:
  <a href="https://abrahamjuliot.github.io/creepjs/" target="_blank" rel="noreferrer">CreepJS</a>
  <a href="https://browserleaks.com/webrtc" target="_blank" rel="noreferrer">WebRTC leak</a>
  <a href="https://www.dnsleaktest.com/" target="_blank" rel="noreferrer">DNS leak</a>
</div>
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
    const html = renderHtml(this._data());
    this.server = http.createServer((req, res) => {
      const url = (req.url || '').split('?')[0];
      if (url !== `/${this.token}`) {
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
      checkIp: o.checkIp !== false,
      ipService: o.ipService || 'https://ipinfo.io/json',
      ipFallback: o.ipFallback || 'https://api.ipify.org?format=json',
      mode: o.mode === 'simple' ? 'simple' : 'advanced',
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
        this.url = `http://127.0.0.1:${this.port}/${this.token}`;
        resolve(this.url);
      });
    });
  }

  close() { try { this.server.close(); } catch {} }
}

module.exports = { StatusPage };
