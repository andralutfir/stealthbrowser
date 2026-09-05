# stealthbrowser

**English** · [Bahasa Indonesia](README.id.md)

A disposable browser. Every launch: **a new profile, a new identity, no traces
left behind.**

This is not a browser built from scratch — it is a launcher that drives the
Chrome, Brave, Edge or Chromium you already have, but on a temporary profile
with an identity randomised over the DevTools Protocol, then wiped completely
when you close it.

No dependencies. No `npm install`. Just Node.js 18+.

Windows, Linux and macOS.

---

## Quick start

```bash
node src/index.js --check
```

```bash
node src/index.js https://duckduckgo.com
```

That is the whole install. `--check` prints one line per prerequisite and tells
you what is missing.

### Two ways to launch it

**The app — Windows.** Double-click `StealthBrowser.exe`. It reads and writes
the same `config.json` as the CLI, and streams the launcher output into the
window so you can watch a session run.

It opens in one of two views, switched from the top-right corner:

| | |
|---|---|
| **Simple** | One page. The browser, the pages to open, how many windows, the connection, data saving, and two identity presets. Enough to run a session without reading anything. |
| **Advanced** | Eleven sections, one per config area — every option in `config.json` has a control. |

Both write the same file, and only the view you can see is read back when you
save, so a change in one is never undone by a stale copy in the other.

If the .exe is not there yet, build it once with `build-exe.cmd`. That compiles
it with the C# compiler already built into Windows — no SDK, no toolchain, no
packages, in line with the rest of the project. Node.js is still required to run
a session.

**The scripts — every platform.** For quick launches and shortcuts:

| Windows | Linux / macOS | What it does |
|---|---|---|
| `stealth.cmd` | `./stealth.sh` | Open one browser |
| `stealth-multi.cmd` | `./stealth-multi.sh` | Ask how many browsers, then open them all |
| `stealth-debug.cmd` | `./stealth-debug.sh` | Open one browser and record the session to `logs/` |
| `build-exe.cmd` | — | Rebuild `StealthBrowser.exe` |

Both routes end up running the same `src/index.js`, so anything you set in one
applies to the other. See **[docs/LINUX.md](docs/LINUX.md)** for the Linux and
macOS specifics.

One difference worth knowing: **the app writes `config.json` as plain JSON**, so
saving from it drops the explanatory comments. The documented copy always lives
in `config.example.json`, and `--init-config` restores it. Your previous file is
kept as `config.json.bak` on every save.

---

## No browser installed? It fetches one

```bash
node src/index.js --list-browsers
node src/index.js --install-browser brave
node src/index.js --install-browser chrome Beta
```

On a machine with no browser at all, the first launch fetches one by itself. The
app has a **Get browser** button for the same thing.

| | |
|---|---|
| **chrome** | Chrome for Testing — Google's own versioned builds, four channels |
| **chromium** | Official upstream snapshots, no Google branding |
| **brave** | The portable ZIP from Brave's own GitHub releases (not on Linux — it ships packages there) |
| edge, vivaldi, opera | **Installer only** — these would write to Program Files and the registry, so the tool reports them instead of running the installer for you |

Everything fetched is a plain archive: nothing is installed, no administrator
rights, no system settings touched. Each browser lands in `browsers/` next to the
project, and deleting that folder undoes it completely. Roughly 190–340 MB each.

An installed browser is always preferred over a downloaded one.

---

## What happens on every launch

**The profile is thrown away.** Each launch gets its own `user-data-dir` in the
temp folder and deletes it on exit — cookies, cache, history, localStorage,
IndexedDB, service workers, all of it. Your real browser profile is never
touched. If the process is killed hard, leftovers are swept on the next launch.

**The identity is randomised, but stays plausible.** Timezone, languages and
geolocation always come from the same location bundle — a Jakarta persona never
ends up with Tokyo coordinates.

| Aspect | How |
|---|---|
| User-Agent + Client Hints | `Emulation.setUserAgentOverride` — fixes the HTTP headers too, not just `navigator.userAgent` |
| Timezone | `Emulation.setTimezoneOverride` — `Intl` and `getTimezoneOffset()` follow |
| Languages | `setLocaleOverride` + `--accept-lang` |
| Geolocation | Coordinates near a city that matches the timezone |
| Screen & window | Resolution, DPR, `outer/inner`, drawn from genuinely common resolutions |
| Hardware | `hardwareConcurrency`, `deviceMemory` |
| GPU | WebGL vendor + renderer (real ANGLE strings) |
| Canvas / WebGL / Audio | Deterministic per-session noise |

The browser's major version is **not** faked — claiming another one is caught by
feature detection immediately. Only the build/patch numbers vary.

The canvas noise is deterministic within a session: the same canvas produces the
same hash. That matters — a value that changes on every call is itself a signal
that something is randomising it.

**See it for yourself:**

```bash
node src/index.js https://abrahamjuliot.github.io/creepjs/
```

### When spoofing is the wrong tool

Some sites run a bot check — Cloudflare Turnstile, hCaptcha's harder modes — and
those look for exactly what this tool does: patched canvas and WebGL, an attached
DevTools session, a script injected into every document, a User-Agent that
disagrees with the binary, a timezone that disagrees with the IP. The symptom is
a widget that renders and then sits on *Verifying…* forever.

For those pages, run without any of it:

```bash
node src/index.js --no-spoof --no-debug --url https://example.com/signup
```

In the app: **Identity → Presets → No spoof**, and **Full stealth** puts it all
back. You keep a disposable profile, an empty cookie jar, no history, everything
wiped on exit, and the network binding. What you give up is the browser lying
about itself — which is what the check objected to.

---

## What it can do

Each of these is one config key, one CLI flag, and one control in the app. The
full reference is in **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**.

**Status tab.** The first tab of a session is a local page showing the current
public IP, its quality score, the identity in use, and — measured live in that
page — what websites *actually* see, each row tagged `match` or `MISMATCH`. A
failed override is visible immediately. It has the same Simple / Advanced switch
as the app.

**IP quality.** The address is scored out of 100: a flagged proxy or VPN costs
50, a datacenter range 35, a browser timezone that disagrees with the IP 15, a
mobile CGNAT address 5. Every deduction is printed with its weight, so the number
can be checked rather than trusted.

**Choose the connection.** Bind a session to WiFi, LAN, a VPN adapter, a second
LAN, or a specific source IP. Two adapters of a kind get numbered — `lan1`,
`lan2` — so the choice is never left to luck.

**Proxies.** HTTP, HTTPS and SOCKS5, with authentication — including SOCKS5 with
a username and password, which Chromium cannot do on its own. One proxy per
instance, cycled.

**Several browsers at once.** Three or four side by side, tiled into tall
columns. They share the screen and nothing else: every instance gets its own
identity, profile and cookie jar.

**Bandwidth saving.** `balanced` removes traffic you never look at — ad payloads,
analytics beacons, autoplaying video — with nothing visibly broken. `strict` also
drops images and web fonts. Captcha and bot-check frames are never touched by
either.

**Session recording.** With `--debug`, every click, keystroke, form submission,
navigation, dialog, download and network failure is written to `logs/` with
timestamps — as a readable log, a `.jsonl` sidecar and a browsable HTML timeline.
Password fields stay redacted.

**Macros.** Replay a recording: the same clicks, the same text in the same
fields, the same submits, in the same order.

**Reproducible personas.** Give a seed and get the exact same identity every
time — for debugging, or for a session you want to be able to repeat.

---

## Known issues

Everything reproduced, with what is understood and what is not, is on one page:
**[docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)**.

The short version: Brave can crash on `Ctrl+T` with full spoofing armed; bot
checks may refuse to finish (use **No spoof**); the desktop app is Windows-only;
Brave cannot be auto-downloaded on Linux.

---

## Limitations

Worth being straight about, because anti-fingerprinting that claims to be perfect
is always lying.

- **Web Workers and Service Workers are not patched.** `Emulation.*` still
  applies there, but JS-level patches like canvas and WebGL only run in the page
  context.
- **The font list is not randomised.** It is one of the strongest signals and
  cannot be changed without wrecking how pages look.
- **Network characteristics are untouched.** TLS/JA3 fingerprint, HTTP/2 header
  ordering, and your IP without a proxy do not change.
- **A random persona is itself a signal.** This tool is built for **session
  separation** — so today's visit cannot be linked to yesterday's — not for
  disappearing. Blending in with the majority (the Tor Browser approach) is a
  stronger strategy for anonymity.
- **If you log in, you are identified.** Fingerprinting stops mattering once you
  tell the site who you are.

For real anonymity against a serious adversary, use Tor Browser.

---

## How it works

```
node src/index.js
  ├─ detect the browser and its version
  ├─ build a persona from a random seed
  ├─ create a temp profile + privacy Preferences
  ├─ (optional) start a local proxy bound to the chosen adapter
  ├─ launch Chromium with --no-startup-window + --remote-debugging-port
  ├─ connect DevTools, arm auto-attach
  ├─ for each page target:
  │     Emulation.setUserAgentOverride / TimezoneOverride / LocaleOverride
  │     Page.addScriptToEvaluateOnNewDocument  <- canvas/WebGL/screen patches
  ├─ open a tab at about:blank, wait until spoofing is armed, then navigate
  └─ on exit: close the browser, wipe the profile, close the log
```

Two things carry the design: `--no-startup-window`, so no page can load before
DevTools is connected, and the *open blank then navigate* pattern, so the first
page never races the spoofing setup.

### Code layout

| File | Responsibility |
|---|---|
| `src/index.js` | CLI, multi-instance manager |
| `src/session.js` | One browser session: profile, process, CDP, logging |
| `src/config.js` | Defaults, commented-JSON parser, CLI overrides |
| `src/identity.js` | Persona builder |
| `src/personas.js` | Data pools: locations, GPUs, resolutions |
| `src/inject.js` | Page-level fingerprint patches |
| `src/statuspage.js` | Local status page server |
| `src/bandwidth.js` | Data-saving tiers, block lists, byte accounting |
| `src/challenge.js` | Captcha / bot-check providers, exempt from saving |
| `src/recorder.js` | Session recorder injected into the page |
| `src/report.js` | HTML timeline written at the end of a session |
| `src/macro.js` | Macro loading and replay |
| `src/download.js` | Fetching and unpacking browsers |
| `src/browser.js` | Browser discovery, command line |
| `src/profile.js` | Temp profile, privacy preferences, wiping |
| `src/proxy.js` | Local proxy: interface binding, SOCKS5, upstream auth |
| `src/net.js` | Adapter discovery and alias resolution |
| `src/layout.js` | Monitor detection and tiling |
| `src/logger.js` | File + console logger |
| `src/cdp.js`, `src/ws.js` | DevTools Protocol client, hand-written WebSocket |
| `gui/` | The Windows app (`build-exe.cmd`) |

---

## Documentation

| | |
|---|---|
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every option, explained |
| [docs/LINUX.md](docs/LINUX.md) | Running on Linux and macOS |
| [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) | Known bugs and workarounds |
| [config.example.json](config.example.json) | The same reference, inline in the config |

---

## Licence

MIT. Copyright by Andra Lutfi Ridhotullah — see [LICENSE](LICENSE).

Use it for your own privacy and for testing what you are allowed to test. It is
not built for evading bot detection, and it will not grow features for that.
