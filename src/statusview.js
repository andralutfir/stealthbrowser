'use strict';
/**
 * The status page markup.
 *
 * Split from statuspage.js so the layout can be read as layout: that file holds
 * what the page measures and how it scores an address, this one holds where it
 * all goes on screen. The measuring script is passed in already stringified,
 * because it runs in the browser rather than here.
 */

/**
 * @param {object} data      the session summary, serialised into the page
 * @param {string} base      URL prefix the page's own assets are served under
 * @param {string} scriptSrc the page script, as source text
 */
function renderHtml(data, base, scriptSrc) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  const card = 'themed rounded-xl border border-zinc-200 bg-white shadow-sm '
    + 'dark:border-zinc-800 dark:bg-zinc-900/40 dark:shadow-none';
  const h2 = 'px-5 pt-4 text-[12px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500';
  const lbl = 'mb-1 block text-[12px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500';
  const seg = 'px-3.5 py-2 text-[13px] font-semibold transition-colors';
  const link = 'ml-3 text-indigo-500 transition-colors hover:text-indigo-400 hover:underline dark:text-indigo-400';

  const themeButton = (value, title, icon) => `<button type="button" data-theme="${value}" title="${title}"
          class="px-2.5 py-2 transition-colors">${icon}</button>`;

  const SUN = `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
    <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
  const SCREEN = `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>`;
  const MOON = `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
  const SHIELD = `<svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3 4 6v6c0 4.5 3.2 7.9 8 9 4.8-1.1 8-4.5 8-9V6z"/><circle cx="12" cy="11" r="2.5"/></svg>`;

  const quality = data.checkQuality;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session ${data.tag || 'stealthbrowser'}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%236366f1'/%3E%3Ccircle cx='8' cy='8' r='3' fill='%23fff'/%3E%3C/svg%3E">
<link rel="stylesheet" href="${base}tailwind.css">
<link rel="stylesheet" href="${base}theme.css">
<script>
  // Applied before the first paint: a page that opens light and turns dark a
  // moment later is worse than either.
  (() => {
    const pref = ${JSON.stringify(data.theme)};
    const dark = pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    addEventListener('DOMContentLoaded', () =>
      requestAnimationFrame(() => document.documentElement.classList.add('theme-ready')));
  })();
</script>
</head>
<body class="themed bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
<div class="mx-auto max-w-5xl px-6 py-9">

  <header class="mb-6 flex flex-wrap items-start gap-4 animate-rise">
    <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-500 shadow-lg shadow-indigo-500/25">${SHIELD}</div>
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold tracking-tight">New session ready${data.tag ? ' &mdash; ' + data.tag : ''}</h1>
      <p class="mt-1 text-[15px] text-zinc-500 dark:text-zinc-400">Disposable profile. The identity below applies to
        this session only and changes the next time the browser opens.</p>
    </div>
    <div class="ml-auto flex shrink-0 items-center gap-2">
      <div id="theme-switch" class="themed flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
        ${themeButton('light', 'Light', SUN)}
        ${themeButton('system', 'Follow the system', SCREEN)}
        ${themeButton('dark', 'Dark', MOON)}
      </div>
      <div class="themed flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
        <button type="button" id="m-simple" class="${seg}">Simple</button>
        <button type="button" id="m-advanced" class="${seg}">Advanced</button>
      </div>
    </div>
  </header>

  <div class="simple-only mb-4 flex items-start gap-3 ${card} px-5 py-4 animate-rise">
    <span id="verdict-dot" class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600"></span>
    <div>
      <b id="verdict-title" class="block text-[17px] font-semibold">Checking&hellip;</b>
      <span id="verdict-detail" class="text-[14px] text-zinc-500 dark:text-zinc-400">Reading what this session actually reports.</span>
    </div>
  </div>

  <div class="mb-4 ${card} px-5 py-4 animate-rise">
    <div class="flex flex-wrap items-baseline gap-x-8 gap-y-4">
      <div>
        <span class="${lbl}">Current public IP</span>
        <b id="ipval" class="text-3xl font-semibold tabular-nums tracking-tight">loading&hellip;</b>
      </div>
      <div>
        <span class="${lbl}">Location</span>
        <span id="ipgeo" class="text-[15px] text-zinc-500 dark:text-zinc-400">&mdash;</span>
      </div>
      <div>
        <span class="${lbl}">Network</span>
        <span id="ipnote" class="text-[15px] text-zinc-500 dark:text-zinc-400">&mdash;</span>
      </div>
${quality ? `      <div class="ml-auto text-right">
        <span class="${lbl}">IP quality</span>
        <b id="qscore" class="text-3xl font-semibold tabular-nums tracking-tight">checking&hellip;</b>
        <span id="qlabel"></span>
      </div>` : ''}
    </div>
${quality ? `    <div class="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <div class="mb-2 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div id="qbar" class="h-full w-0 rounded-full bg-zinc-300 transition-all duration-700 ease-out dark:bg-zinc-600"></div>
      </div>
      <table class="w-full text-[15px]"><tbody id="qrows"></tbody></table>
      <p id="qnote" class="mt-2 text-[13px] leading-relaxed text-zinc-500">Asking the lookup service what this address looks like&hellip;</p>
    </div>` : ''}
  </div>

  <div class="simple-only ${card} pb-3 animate-rise">
    <h2 class="${h2}">In plain words</h2>
    <table class="w-full text-[15px]"><tbody id="plain"></tbody></table>
  </div>

  <div class="adv-only ${card} pb-3 animate-rise">
    <h2 class="${h2}">Session</h2>
    <table class="w-full text-[15px]"><tbody id="sess"></tbody></table>
  </div>

  <div class="adv-only mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
    <div class="${card} pb-3 animate-rise">
      <h2 class="${h2}">Identity applied</h2>
      <table class="w-full text-[15px]"><tbody id="set"></tbody></table>
    </div>
    <div class="${card} pb-3 animate-rise">
      <h2 class="${h2}">What websites actually see</h2>
      <table class="w-full text-[15px]"><tbody id="seen"></tbody></table>
    </div>
  </div>

  <p class="adv-only mt-5 text-[14px] text-zinc-500">
    Test further:
    <a class="${link}" href="https://abrahamjuliot.github.io/creepjs/" target="_blank" rel="noreferrer">CreepJS</a>
    <a class="${link}" href="https://browserleaks.com/webrtc" target="_blank" rel="noreferrer">WebRTC leak</a>
    <a class="${link}" href="https://www.dnsleaktest.com/" target="_blank" rel="noreferrer">DNS leak</a>
  </p>
</div>
<script>(${scriptSrc})(${json});</script>
</body></html>`;
}

module.exports = { renderHtml };
