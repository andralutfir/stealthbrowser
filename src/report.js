'use strict';
/**
 * Session replay report: a single self-contained HTML timeline written when the
 * session ends. The .log file is for grepping and the .jsonl for tooling; this
 * one is for actually reading back what happened, in order, with times.
 */
const fs = require('fs');
const path = require('path');

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#14161a;--dim:#6b7280;
--line:#e3e6ea;--accent:#2f6feb;--ok:#0a7d32;--warn:#a15c00;--bad:#b42318;--nav:#7c3aed}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--fg:#e6e8ec;
--dim:#9aa1ac;--line:#252932;--accent:#6ea8fe;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--nav:#a78bfa}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);
font:14px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto}
h1{font-size:18px;margin:0 0 2px;font-weight:650}
.sub{color:var(--dim);font-size:12.5px;margin-bottom:18px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat b{display:block;font-size:21px;font-weight:650;font-variant-numeric:tabular-nums}
.stat span{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.6px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:4px 16px 12px;margin-bottom:14px}
.panel h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);margin:12px 0 8px;font-weight:600}
table{width:100%;border-collapse:collapse}
td{padding:4px 0;vertical-align:top;border-bottom:1px solid var(--line);font-size:13px}
tr:last-child td{border-bottom:0}
td.k{color:var(--dim);width:180px;padding-right:10px;white-space:nowrap}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.filters button{border:1px solid var(--line);background:var(--card);color:var(--fg);
border-radius:20px;padding:3px 11px;font-size:12px;cursor:pointer;font-family:inherit}
.filters button.off{opacity:.4}
.ev{display:grid;grid-template-columns:78px 62px 1fr;gap:10px;padding:5px 0;
border-bottom:1px solid var(--line);font-size:13px;align-items:baseline}
.ev:last-child{border-bottom:0}
.ev .t{color:var(--dim);font-variant-numeric:tabular-nums;font-size:12px;
font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.ev .v{font-size:10.5px;font-weight:700;letter-spacing:.4px;padding:1px 6px;border-radius:4px;
text-align:center;background:color-mix(in srgb,var(--dim) 15%,transparent);color:var(--dim)}
.ev .d{word-break:break-word}
.v-CLICK,.v-DBLCLK,.v-RCLICK{background:color-mix(in srgb,var(--accent) 18%,transparent)!important;color:var(--accent)!important}
.v-TYPE,.v-CHANGE,.v-SELECT,.v-TOGGLE,.v-FILE{background:color-mix(in srgb,var(--ok) 18%,transparent)!important;color:var(--ok)!important}
.v-SUBMIT{background:color-mix(in srgb,var(--warn) 20%,transparent)!important;color:var(--warn)!important}
.v-NAV,.v-READY,.v-LEAVE{background:color-mix(in srgb,var(--nav) 18%,transparent)!important;color:var(--nav)!important}
.v-ERROR,.v-FAILED,.v-DIALOG{background:color-mix(in srgb,var(--bad) 18%,transparent)!important;color:var(--bad)!important}
.tab{color:var(--dim);font-size:11px;margin-right:6px}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.muted{color:var(--dim)}
.empty{color:var(--dim);padding:14px 0}
`;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 100))}`;
}

function pageScript() {
  const buttons = document.querySelectorAll('.filters button');
  const rows = Array.from(document.querySelectorAll('.ev'));
  const off = new Set();
  buttons.forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.dataset.verb;
      if (off.has(v)) { off.delete(v); b.classList.remove('off'); }
      else { off.add(v); b.classList.add('off'); }
      rows.forEach((r) => { r.hidden = off.has(r.dataset.verb); });
    });
  });
}

/**
 * @param {string} file    output path
 * @param {object} meta    { tag, browser, identity, network, proxy, profile, started, ended, bandwidth, urls }
 * @param {Array}  events  [{ at, verb, text, tab }]
 */
function writeReport(file, meta, events) {
  const counts = {};
  for (const e of events) counts[e.verb] = (counts[e.verb] || 0) + 1;

  const interactions = events.filter((e) => ['CLICK', 'DBLCLK', 'RCLICK', 'TYPE', 'CHANGE', 'SELECT', 'TOGGLE', 'SUBMIT', 'KEY', 'FILE'].includes(e.verb)).length;
  const pages = events.filter((e) => e.verb === 'NAV').length;
  const durationMs = Math.max(0, (meta.ended || Date.now()) - meta.started);

  const stat = (label, value) => `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const row = (k, v, cls) => `<tr><td class="k">${esc(k)}</td><td class="${cls || ''}">${esc(v)}</td></tr>`;

  const verbs = Object.keys(counts).sort();
  const filters = verbs.map((v) =>
    `<button data-verb="${esc(v)}">${esc(v)} <span class="muted">${counts[v]}</span></button>`).join('');

  const rowsHtml = events.length
    ? events.map((e) => `<div class="ev" data-verb="${esc(e.verb)}">`
      + `<div class="t">${clock(e.at)}</div>`
      + `<div class="v v-${esc(e.verb)}">${esc(e.verb)}</div>`
      + `<div class="d">${e.tab ? `<span class="tab">${esc(e.tab)}</span>` : ''}${esc(e.text)}</div>`
      + '</div>').join('')
    : '<div class="empty">No events were recorded in this session.</div>';

  const id = meta.identity || {};
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session recording ${esc(meta.tag || '')}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%232f6feb'/%3E%3Ccircle cx='8' cy='8' r='3' fill='%23fff'/%3E%3C/svg%3E">
<style>${CSS}</style></head>
<body><div class="wrap">
<h1>Session recording${meta.tag ? ' &mdash; ' + esc(meta.tag) : ''}</h1>
<div class="sub">${esc(new Date(meta.started).toLocaleString('en-GB'))} &middot; lasted ${(durationMs / 1000).toFixed(1)}s &middot; disposable profile, wiped after this run</div>

<div class="cards">
  ${stat('events', events.length)}
  ${stat('interactions', interactions)}
  ${stat('page loads', pages)}
  ${stat('duration', (durationMs / 1000).toFixed(0) + 's')}
  ${stat('downloaded', meta.bandwidth || '-')}
</div>

<div class="panel"><h2>Session</h2><table>
${row('Browser', meta.browser)}
${row('Connection', meta.network)}
${row('Proxy', meta.proxy || 'not used')}
${row('Bandwidth mode', meta.bandwidthMode || 'off')}
${row('Startup URLs', (meta.urls || []).join('  '))}
${row('Profile', meta.profile, 'mono muted')}
</table></div>

<div class="panel"><h2>Identity used</h2><table>
${row('User-Agent', id.userAgent, 'mono')}
${row('Platform', `${id.chPlatform || ''} ${id.platformVersion || ''}`.trim())}
${row('Languages', (id.languages || []).join(', '))}
${row('Timezone', id.timezone)}
${row('Screen', id.screen ? `${id.screen.width}x${id.screen.height} @${id.screen.dpr}x` : '')}
${row('CPU / RAM', id.hardwareConcurrency ? `${id.hardwareConcurrency} cores / ${id.deviceMemory} GB` : '')}
${row('GPU', id.webgl ? id.webgl.renderer : '')}
${row('Seed', id.seed, 'mono')}
</table></div>

<div class="panel"><h2>Timeline</h2>
<div class="filters">${filters}</div>
${rowsHtml}
</div>
</div>
<script>(${pageScript.toString()})();</script>
</body></html>`;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

module.exports = { writeReport };
