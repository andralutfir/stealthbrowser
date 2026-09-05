# Running on Linux and macOS

The launcher is plain Node.js with no dependencies, so it runs anywhere Node
does. Only the desktop app is Windows-only; everything it does is available from
the command line and the shell scripts.

---

## Requirements

- **Node.js 18 or newer** — `node --version`
- **A Chromium-family browser**, or none at all: the tool fetches one on the
  first launch if the machine has nothing installed.

Nothing else. No `npm install`, no build step, no root.

---

## First run

```bash
git clone https://github.com/andralutfir/stealthbrowser.git
cd stealthbrowser
cp config.example.json config.json
chmod +x *.sh
./stealth.sh --check
```

`--check` prints one line per prerequisite, including the platform it detected:

```
  [ok]   Node.js - v22.18.0
  [ok]   Platform - Linux x64
  [ok]   Config file - /home/you/stealthbrowser/config.json
  [ok]   Browsers detected - chrome, chromium
  [ok]   Selected browser - Google Chrome 152.0.7977.82
  [ok]   Network interface - wlp3s0 192.168.1.24
  [ok]   Monitor - 1920x1040 (xrandr)
```

Then:

```bash
./stealth.sh                      # one browser
./stealth.sh https://duckduckgo.com
./stealth-multi.sh 3              # three side by side, each its own identity
./stealth-debug.sh                # one browser, session recorded to logs/
```

The `.sh` scripts are thin wrappers around `node src/index.js`; every CLI option
works through them.

---

## Where browsers are found

Fixed locations are checked first, then `PATH`:

| Browser | Looked for |
|---|---|
| Chrome | `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`, `/opt/google/chrome/chrome`, `/usr/local/bin/google-chrome` |
| Brave | `/usr/bin/brave-browser`, `/usr/bin/brave`, `/opt/brave.com/brave/brave-browser`, `/snap/bin/brave`, the Flatpak export |
| Edge | `/usr/bin/microsoft-edge`, `-stable`, `/opt/microsoft/msedge/msedge` |
| Vivaldi | `/usr/bin/vivaldi`, `-stable`, `/opt/vivaldi/vivaldi` |
| Opera | `/usr/bin/opera`, `/snap/bin/opera` |
| Chromium | `/usr/bin/chromium`, `-browser`, `/snap/bin/chromium`, the Flatpak export |

Anything installed somewhere else is picked up from `PATH` by its usual command
name, so a manual install needs no configuration. Failing all of that, point
`"browser"` at the executable directly:

```json
"browser": "/opt/my-build/chrome"
```

On macOS the `/Applications/*.app/Contents/MacOS/*` binaries are used.

### Snap and Flatpak

Both work, with one caveat: a confined Chromium can only reach paths its sandbox
allows. If a launch fails with a profile error, move the profile somewhere the
sandbox can see:

```json
"privacy": { "profileRoot": "/home/you/.cache/stealthbrowser" }
```

---

## Downloading a browser

```bash
node src/index.js --list-browsers
node src/index.js --install-browser chrome      # Chrome for Testing, linux64
node src/index.js --install-browser chromium    # upstream snapshot, Linux_x64
```

Archives are unpacked by the launcher itself, and the executable bit recorded in
the ZIP is preserved — the unpacked binary is runnable straight away.

**Brave cannot be fetched on Linux.** It publishes `.deb` / `.rpm` packages
rather than a portable archive, so install it from
[brave.com/linux](https://brave.com/linux/) and it will be detected.

---

## Choosing the connection

Adapters are listed the same way as on Windows, with the aliases resolved from
their real kind:

```bash
node src/index.js --list-interfaces
```

```
  wlp3s0     192.168.1.24     (wifi, Up)
  enp0s31f6  192.168.1.9      (ethernet, Up)
  wg0        10.7.0.2         (vpn, Up)
```

```json
"network": { "interface": "wifi" }
```

Link state comes from `/sys/class/net/<name>/operstate`, so a cable that is
plugged in but dead is ranked below one that works. Wireless adapters are
recognised by `/sys/class/net/<name>/wireless` rather than by name, so an
unusually named adapter is still classified correctly.

Two adapters of the same kind get numbered — `lan1`, `lan2` — and asking for the
bare alias tells you which is which instead of picking one at random.

---

## Window tiling

Multi-instance tiling needs the screen size. On Linux it comes from `xrandr`; if
that is missing (a Wayland session without XWayland, or a headless box) the
launcher falls back to 1920x1040 and says `default` in `--check`. Set it
yourself when that is wrong:

```json
"instances": { "monitor": { "width": 2560, "height": 1400 } }
```

Chromium positions its own windows, so tiling works under X11 and under most
Wayland compositors. A compositor that ignores window geometry requests will
place them itself — the identities are still independent, only the layout is
lost.

---

## What is not available

- **`StealthBrowser.exe`** — the settings app is WinForms. Use `config.json`
  plus the CLI; every option in the app maps one-to-one onto a config key, and
  `config.example.json` documents all of them.
- **`build-exe.cmd`** — Windows only, and only needed for the app.
- **Fetching Brave** — see above.

---

## Headless servers

There is no headless mode: the point of the tool is a real browser window. On a
box with no display, run it under a virtual one:

```bash
xvfb-run -s "-screen 0 1920x1080x24" ./stealth.sh --url https://example.com
```

Note that Chromium under Xvfb reports a software renderer, which is itself a
distinctive fingerprint. It is fine for testing the plumbing, less so for
blending in.
