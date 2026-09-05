# Configuration reference

Everything the launcher does is driven by **`config.json`**.
`config.example.json` documents every option inline; this page explains the ones
that need more than a line.

`//` and `/* */` comments are allowed in both files.

## Precedence

```
DEFAULTS (src/config.js)  <  config.json  <  CLI options
```

Rightmost wins. Which means: **editing `DEFAULTS` in `src/config.js` does nothing
if the same key also appears in `config.json`** — the config file overrides it.
Edit `config.json`, not the source.

## The config is re-read on every run

There is no cache and no daemon to restart. Save `config.json`, run again, done.
If a change does not seem to apply, it is almost always one of three things:

**1. Check what is actually in effect:**

```bash
node src/index.js --print-config
```

The first line names the file that was read, followed by the effective values
after all layers are merged.

**2. The file was not found.** `config.json` is looked for in the directory you
run the command from, then in the project folder. If it is in neither, the
launcher now warns instead of silently falling back to defaults. Running through
the `.cmd` files or from the project folder always works.

**3. A CLI option overrode it.** `--interface`, `--count`, `--url` and friends
always beat the config file.

## Starting a fresh config

```bash
node src/index.js --init-config
```

Rewrites `config.json` from `config.example.json`, which carries every option
with its documentation. The old file is backed up to `config.json.bak`.

## Startup URLs

```json
"startup": { "urls": ["https://duckduckgo.com", "https://mail.proton.me"] }
```

One tab per URL. Tabs are opened over DevTools **after** all spoofing is armed,
so the first page never gets a chance to read a real value.

## Status tab: identity + current IP

```json
"statusPage": { "enabled": true }
```

```bash
node src/index.js --status
```

The first tab of each session becomes a summary page; the URLs in `startup.urls`
open right after it. It shows:

- **The current public IP**, with city, ISP and a quality score
- **Identity applied** — UA, platform, languages, timezone, screen, CPU/RAM, GPU, seed
- **What websites actually see** — measured live in that page, each row tagged
  `match` or `MISMATCH`

That second column is what makes it useful: not just a summary, but a live check
that the spoofing really took effect. A `MISMATCH` means an override failed.

The page is served by the launcher from `127.0.0.1` on a random path, with no
external files — about 9 KB, instant. The IP is fetched by the page itself
rather than by Node, so the request travels the exact same path as normal browser
traffic — the address already accounts for interface binding and any proxy.

The IP stays the same as long as the connection does; the identity is what
changes on every launch.

Set `"checkIp": false` if you want no outbound request at all when the browser
opens.

## IP quality

The same card scores how a website is likely to judge the address it sees:

```
CURRENT PUBLIC IP   LOCATION           NETWORK                    IP QUALITY
140.213.26.216      Jakarta, ID        AS24203 PT XL Axiata       80%  usable
──────────────────────────────────────────────────────────────────────────────
Address type              residential or business ISP                       ok
Carrier                   mobile, shared behind CGNAT                       −5
Browser timezone vs IP    Europe/Warsaw vs Asia/Jakarta                    −15
```

It starts at 100 and subtracts what the lookup actually reported:

| Finding | Cost |
|---|---|
| Flagged as a proxy, VPN or Tor exit | −50 |
| Datacenter / hosting range | −35 |
| Browser timezone disagrees with the IP's | −15 |
| Mobile carrier, shared behind CGNAT | −5 |

85+ is `clean`, 65+ `usable`, 40+ `questionable`, below that `poor`. Every
deduction is printed with its weight, so the number can be checked rather than
trusted — there is no hidden term in the total.

The timezone row is worth watching: a randomised persona in `Europe/Warsaw`
behind an Indonesian IP is the single most common thing that makes a session
look wrong, and it is the one part of the score you control.

Defaults to `ip-api.com` — free, no key, no account. Plain HTTP is what that
tier serves; the status page is local HTTP too, so nothing is downgraded, and
the lookup travels this session's own proxy like everything else. Point
`qualityService` at any service reporting `proxy` / `hosting` / `mobile` under
the same names to use that instead, or set `"checkQuality": false` to drop the
second lookup. When the service cannot be reached the page says so and shows no
score — never a guessed one.

This is how the address classifies, not a fraud-score subscription. A site
running its own scoring can and will disagree.

## Choosing the connection: WiFi, LAN, or VPN

```bash
node src/index.js --list-interfaces
```

```
  NordLynx                     10.5.0.2         (vpn, Up)
  Ethernet                     192.168.0.69     (ethernet, Up)
  Wi-Fi                        10.242.54.50     (wifi, Up)
```

```bash
node src/index.js --interface wifi
node src/index.js --interface lan
node src/index.js --interface "Ethernet"
node src/index.js --interface 192.168.0.69
```

**Two adapters of the same kind** — a second Ethernet port on a USB-C dock, say —
make a bare `lan` ambiguous, so it is refused rather than resolved by luck:

```
"lan" matches 2 active ethernet interfaces - pick one:
    lan1   Ethernet    (192.168.0.69)   Realtek Gaming 2.5GbE Family Controller
    lan2   Ethernet 2  (192.168.5.20)   USB 10/100/1000 LAN
  e.g. --interface lan2   or   --interface "Ethernet 2"   or   --interface 192.168.5.20
```

Every alias takes a number — `lan1`, `lan2`, `wifi2`, `vpn2` — following the order
`--list-interfaces` prints. The GUI's Network tab lists all of them with the
adapter and IP each one means, so there is nothing to memorise.

The second adapter needs its own working route. Binding sets the source address;
if that network has no gateway, pages will not load at all. Turn on the status
tab to see the public IP the session actually got — that is the proof it went out
the adapter you picked.

Chromium has no flag for picking the outgoing adapter. So the launcher starts a
small proxy on `127.0.0.1` that opens every outbound socket with the
`localAddress` of your chosen adapter — that is what actually forces traffic down
that path. DNS queries are bound to the same adapter, so hostnames do not leak
out of the default route.

Traffic to `localhost` stays direct and does not go through the proxy, so local
development servers remain reachable.

## Proxies

```bash
node src/index.js --proxy socks5://user:pass@host:1080
node src/index.js --proxy http://user:pass@host:8080
```

SOCKS5 **with authentication** is fully supported, which Chromium itself cannot
do. Interface binding and proxying combine: the connection to the proxy is
itself opened from the adapter you picked.

One proxy per instance in multi mode:

```json
"network": { "proxies": ["socks5://a:1080", "socks5://b:1080", "socks5://c:1080"] }
```

```bash
node src/index.js --count 3 --proxy socks5://a:1080 --proxy socks5://b:1080
```

If there are more instances than proxies, the list cycles.

## Several browsers at once

```bash
node src/index.js --count 4
```

The screen is split into tall columns — on a 1920px monitor, four browsers of
480px each at full height. **Only the window geometry is coordinated.** Identity,
profile, cookie jar and proxy stay completely separate per instance.

```bash
node src/index.js --count 6 --layout tile --columns 3   # 3 cols x 2 rows
node src/index.js --count 3 --layout cascade            # stepped stack
node src/index.js --count 3 --layout none               # free placement
```

Each persona's fake screen resolution is automatically chosen large enough to
contain its real window. Otherwise `innerWidth` could exceed `screen.width`, and
that contradiction is itself a signal. The same applies to
`"windowSize": "maximized"`.

Chromium refuses windows narrower than ~400px, so past 5–6 columns the windows
start to overlap. The launcher tells you when that happens.

Ctrl+C shuts every instance down together.

## Bandwidth saving

```json
"bandwidth": { "mode": "balanced" }
```

```bash
node src/index.js --bandwidth balanced
node src/index.js --bandwidth strict
```

Two tiers, both built around one rule: **the page has to still work.**

| | `balanced` | `strict` |
|---|---|---|
| Ad / tracker payloads | blocked | blocked |
| Video & audio streams | blocked | blocked |
| Video autoplay | blocked | blocked |
| `Save-Data: on` header | sent | sent |
| Images | **kept** | blocked |
| Web fonts | **kept** | blocked |
| CSS & JavaScript | kept | kept |

`balanced` is the one for daily use. It only removes traffic you never actually
look at — ad payloads, analytics beacons, autoplaying video — so nothing about
the page changes visually. Measured on wikipedia.org: **79 KB over 6 requests**.

The `Save-Data` header is the quiet win: CDNs and image pipelines that honour it
serve smaller variants of the same images, so you save bytes without losing
anything. Worth knowing it is also one more bit of entropy about your browser.

`strict` additionally drops images and web fonts. Pages stay readable and
clickable, but look plain and lose their icon fonts. Images are turned off
through Chromium's own image content setting rather than by blocking URLs, so
the browser never even asks for them.

## Captchas are never optimised

A challenge widget is the one thing that must not be made lighter: block its
images and the puzzle grid is empty boxes, block its fonts and the buttons land
on top of each other, block its audio and the accessibility option is gone. All
three look like "the captcha will not load".

So `allowChallenges` (on by default) carves them out:

```json
"bandwidth": { "mode": "strict", "allowChallenges": true }
```

* hCaptcha, reCAPTCHA, Turnstile, Arkose / FunCaptcha, GeeTest, Friendly
  Captcha, DataDome, PerimeterX, AWS WAF and Yandex SmartCaptcha are recognised
  by host, plus any URL under `/recaptcha/`, `/turnstile/`, `/captcha/` or
  `/cdn-cgi/challenge-platform/`.
* The moment a frame navigates to one, blocking is lifted **for that frame's
  target only** — the page around it keeps saving everything it was saving. It
  goes back on when the tab navigates somewhere else.
* Their origins also keep images and third-party cookies through profile
  content settings. Because a content setting cannot look at a path, that
  covers `google.com` and `gstatic.com` as a whole — the price of a working
  reCAPTCHA. Set `"allowChallenges": false` if you would rather not pay it.

Every switch can be overridden individually — e.g. strict but keep images:

```json
"bandwidth": { "mode": "strict", "blockImages": false }
```

Add your own patterns with `extraBlockPatterns`, e.g. `["*.gif*"]`.

When the session ends you get the actual usage:

```
  bandwidth    : 79 KB downloaded, 6 requests, 14 blocked
```

Blocking is enforced inside the browser via `Network.setBlockedURLs`. Routing
every request out to Node and back would give finer control but add latency to
every page load — the wrong trade for a feature meant to make browsing lighter.

## Macros: replay a recording

Any recorded session can be performed again - same clicks, same text in the same
fields, same submits, in the same order.

```bash
node src/index.js --replay logs/2026-09-03_23-45-47_41c418f3.jsonl
node src/index.js --replay macros/checkout.json --speed 2
```

```json
"macro": { "file": "macros/checkout.json", "speed": 1 }
```

Nothing extra has to be captured for this: the `.jsonl` every recorded session
already writes carries the selectors, the values and the timings. Point the
replay at a `.jsonl` straight from `logs/`, or save a tidied copy under
`macros/`.

```
  macro        : 7 steps (2 change, 1 click, 1 nav, 1 select, 1 submit, 1 toggle) over 9.5s
    1/7  NAV     navigated to http://127.0.0.1:26241/
    2/7  CHANGE  typed into input[email]#email "Email address"
    3/7  CHANGE  typed into textarea#note "Note"
    4/7  SELECT  selected "Singapore"
    5/7  TOGGLE  checked input[checkbox]#tos "I accept the terms"
    6/7  CLICK   clicked button#submit "Pay now"
    7/7  SUBMIT  submitted POST /charge
  macro        : 7 done, 0 skipped, 0 failed
```

Replayed actions are real mouse and keyboard events dispatched through the
DevTools Input domain, not `el.click()` from JavaScript, so pages that listen for
genuine input behave the way they did while recording. Each step waits for its
element to appear before acting, so a slower page load does not break the run.

The replay happens inside a normal session, which means **a fresh identity and a
fresh profile every time** - the same actions from a different-looking browser.

| Setting | Meaning |
|---|---|
| `speed` | `1` = as recorded, `2` = twice as fast |
| `maxDelayMs` | ceiling on the wait between steps |
| `waitForMs` | how long to wait for an element before skipping the step |
| `stopOnMissing` | stop at the first step that cannot be performed |
| `secrets` | values for fields the recording masked |

Masked fields cannot be replayed from the recording alone - that is the point of
masking them. Supply them explicitly when you need them:

```json
"macro": { "secrets": { "#password": "hunter2" } }
```

## Session recording (debug mode)

```bash
node src/index.js --debug
```

Records what actually happened in the browser — every click, every field, with
timestamps — and writes three files per session into `logs/`:

| File | For |
|---|---|
| `<time>_<tag>.log` | reading and grepping |
| `<time>_<tag>.jsonl` | tooling — one JSON object per event |
| `<time>_<tag>.html` | **the timeline you actually open** |

The `.log` looks like this:

```
[22:47:15.412] +   0.5s INFO  nav      tab1  127.0.0.1:52871
[22:47:21.161] +   6.3s INFO  change   tab1  input[email]#email "Email address" = "andra@example.com"
[22:47:22.370] +   7.5s INFO  change   tab1  input[text]#card "Card number" = ******** (redacted, 16 chars)
[22:47:23.590] +   8.7s INFO  change   tab1  input[password]#pw "Password" = ******** (redacted, 17 chars)
[22:47:26.009] +  11.1s INFO  select   tab1  select#country "Country" -> "Singapore"
[22:47:26.011] +  11.1s INFO  toggle   tab1  input[checkbox]#tos "I accept the terms" -> checked
[22:47:26.431] +  11.5s INFO  scroll   tab1  75% of page
[22:47:26.915] +  12.0s INFO  key      tab1  Ctrl+Enter  on page
[22:47:26.917] +  12.0s INFO  click    tab1  button#submit "Pay now"
[22:47:26.918] +  12.0s INFO  submit   tab1  form#pay POST /charge  {email="andra@example.com",
                                              card_number=<redacted:16>, password=<redacted:17>,
                                              note="please deliver after 5pm", country="sg", tos="on"}
```

Every line carries wall-clock time **and** an offset from session start, so a
recording reads by "12 seconds in" rather than by absolute time.

Elements are named the way a person would name them: the tag and id, plus the
control's real label pulled from `aria-label`, its `<label>`, placeholder, title
or button text. `button#submit "Pay now"` beats a bare CSS selector.

**What gets recorded**

| | |
|---|---|
| Clicks | element, its label, link target, modifier keys, coordinates |
| Typing | which field and what was entered, one entry per field, not per keystroke |
| Dropdowns | the option text that was chosen |
| Checkboxes | checked / unchecked |
| Form submits | action, method, and every field with its value |
| Keyboard | named keys (Enter, Escape, Tab, arrows, F-keys) and shortcuts |
| Scrolling | 25 / 50 / 75 / 100% depth milestones |
| Navigation | URL, page title, load time, dwell time per page |
| Also | new tabs, popups, downloads, file pickers, dialogs, JS errors, console output, requests |

**What stays masked**

Password fields and credential-shaped fields are redacted by default — detected
by input type, `autocomplete`, and names containing `pass`, `token`, `secret`,
`cvv`, `card`, `ssn` or `pin`. The log records that the field was filled and how
long the value was, never the value:

```
input[password]#pw "Password" = ******** (redacted, 17 chars)
```

Plain characters typed at the keyboard are never captured either — only named
keys and shortcuts. A recording that transcribes your passwords is worse than no
recording at all.

If you genuinely want everything, `"redactSecrets": false` writes real passwords
into a plain text file on disk. Turn it on deliberately or not at all.

**Tuning it**

```bash
node src/index.js --debug --log-level debug   # also every network request
node src/index.js --debug --no-log-console    # write files, keep the terminal quiet
node src/index.js --debug --log-file trace.log
```

```json
"debug": {
  "enabled": true,
  "captureValues": false,   // record which field, never its contents
  "captureKeys": false,
  "captureScroll": false,
  "htmlReport": false,
  "typeIdleMs": 900         // pause before a field's value is recorded
}
```

The recorder is injected as its own script, separate from the fingerprint
patches, so it can never take those down with it. Its callback name is
randomised per session — a fixed `window.__sbLog` would be a global any site
could probe for, which would undo the work the rest of the project does.

## Reproducible personas

```bash
node src/index.js --print-identity
```

```bash
node src/index.js --seed bf2945e84b589837814b54f2
```

Useful for debugging: the exact same persona comes back. In multi mode the seed
is still varied per instance (`seed#0`, `seed#1`, ...) so identities never clone.

---


## All CLI options

```bash
node src/index.js --help
```

| Option | Meaning |
|---|---|
| `--url <url>` | Startup URL (repeatable) |
| `--browser <id\|path>` | `chrome` `brave` `edge` `vivaldi` `opera` `chromium` or a path to the `.exe` |
| `--interface <spec>` | `auto` `wifi` `lan` `vpn` / interface name / source IP |
| `--proxy <url>` | Upstream proxy (repeatable for multi mode) |
| `--count <n>`, `-n <n>` | How many browsers to open at once |
| `--layout <mode>` | `tile` `cascade` `none` |
| `--columns <n>`, `--gap <px>` | Tiling adjustments |
| `--status`, `--no-status` | Show or hide the identity + IP status tab |
| `--bandwidth <mode>` | `off` `balanced` `strict` — data saving |
| `--replay <file>` | Replay a recording or saved macro |
| `--speed <n>` | Replay pacing |
| `--debug`, `--no-debug` | Turn logging on or off for this run |
| `--log-level <level>` | `error` `warn` `info` `debug` |
| `--log-file <file>`, `--no-log-console` | Log destination |
| `--seed <string>` | Reproduce a specific persona |
| `--window <spec>` | `random` `maximized` `1280x800` |
| `--incognito` | Incognito on top of the disposable profile |
| `--keep-profile` | Keep the profile on exit |
| `--no-spoof` | Turn off all spoofing |
| `--verbose` | Launcher internals |
| `--config <file>` | Use a different config file |
| `--list-interfaces` | Available network interfaces |
| `--list-browsers` | Detected browsers, and what can be downloaded |
| `--install-browser [ch]` | Download a browser (`Stable` `Beta` `Dev` `Canary`) |
| `--no-download` | Never fetch a browser automatically |
| `--print-identity` | Print the persona without opening a browser |
| `--print-config` | Print the effective config and which file was read |
| `--init-config` | Rewrite `config.json` from `config.example.json` |
| `--check` | Setup health check |

---



---

## Two views in the app

`gui.mode` decides which view `StealthBrowser.exe` opens in:

| | |
|---|---|
| `"simple"` | One page: browser, pages to open, how many windows, connection, proxy, data saving, the identity presets, and two switches. Enough to run a session. |
| `"advanced"` | The full surface — eleven sections, one per config area, every key in this document. |

Both write the same `config.json`, and the switch is in the top-right corner of
the window. Only the view you can see is read back when you save, so changing a
value in one view is never quietly undone by a stale copy in the other.

The status page has the same split, set by `statusPage.mode`, and the same
switch in its top-right corner:

| | |
|---|---|
| `"simple"` | A verdict line — *everything checks out*, or what needs attention — then the session in sentences. |
| `"advanced"` | The full side-by-side: what was configured against what the browser actually reports, every row tagged `match` or `MISMATCH`. |
