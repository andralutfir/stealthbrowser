# Known issues

Everything here has been reproduced. Where a cause is known it is named; where
it is not, that is said plainly rather than guessed at.

---

## 1. Brave can crash when you open a new tab

**What happens.** With full spoofing armed, pressing `Ctrl+T` in Brave
intermittently takes the whole browser down with `STATUS_BREAKPOINT`. Chrome,
Chromium and Edge are unaffected.

**What was established.** Bisected across nine configurations:

| Configuration | Result |
|---|---|
| Chrome, full spoofing | survived 3/3 |
| Brave, no spoofing | survived 3/3 |
| Brave, launched directly with no DevTools | survived 3/3 |
| Brave, full `Emulation.*` overrides | crashed intermittently |

So it is Brave's own fingerprint-protection layer reacting to the `Emulation.*`
overrides, not the tool's page scripts.

**What is in place.** New tabs are redirected off the built-in new tab page
before anything is armed (`startup.newTabUrl`), and Brave's new tab dashboard is
disabled through profile preferences. Both make it much rarer. Neither fixes it.

**Workarounds.** Use Chrome or Chromium for sessions where you open many tabs,
or open new tabs by middle-clicking a link rather than with `Ctrl+T`.

---

## 2. Bot checks may never finish

**What happens.** Cloudflare Turnstile, and hCaptcha in its harder modes, can sit
on *Verifying…* forever instead of completing.

**Why.** This is the bot check working as designed, not a bug in the plumbing —
every request to `challenges.cloudflare.com` returns 200 through the proxy. A
session here is genuinely instrumented: DevTools is attached with the `Runtime`
domain enabled, a script is injected into every document, canvas / WebGL / audio
are patched, the User-Agent claims a browser that is not the binary running, and
a randomised timezone rarely agrees with the exit IP. Those are exactly the
signals a challenge platform looks for.

**Workaround.** Run those pages without any of it:

```bash
node src/index.js --no-spoof --no-debug --url https://example.com/signup
```

In the app: **Identity → Presets → No spoof**. You keep the disposable profile,
the empty cookie jar and the network binding; you give up the browser lying
about itself, which is what the check objected to.

This project will not ship countermeasures against bot detection.

---

## 3. `requestStorageAccess: Permission denied` under Brave

reCAPTCHA logs this in every Brave session. It comes from Brave Shields, which
this tool does not override — the cookie and storage-access exceptions written
into the profile apply to Chrome, Chromium and Edge. reCAPTCHA still works; the
call is best-effort and it falls back. Cosmetic, but it will be in your log.

---

## 4. Blocked images leave alt-text placeholders

In `strict` mode with `bandwidth.allowChallenges` on (the default), images are
turned off through the profile's content settings rather than the command-line
switch, because only content settings can carry a per-origin exception for
captcha providers. The visible difference is that blocked images now leave their
alt text behind instead of collapsing silently.

Set `"allowChallenges": false` to go back to the absolute command-line switch —
at the cost of captcha image challenges rendering as empty boxes.

---

## 5. The desktop app is Windows only

`StealthBrowser.exe` is WinForms, built with the C# compiler that ships with
Windows. There is no Linux or macOS build. Everything the app does is available
from the CLI and the shell scripts — see [LINUX.md](LINUX.md).

---

## 6. Brave has no portable Linux archive

`--install-browser brave` works on Windows and macOS. On Linux, Brave publishes
packages rather than a portable archive, so the downloader skips it. Chrome for
Testing and Chromium snapshots both fetch normally on Linux.

---

## 7. Combo box arrows keep the system light chrome

In the app's dark theme the drop-down button drawn by Windows on a `ComboBox`
stays light. Everything around it is owner-drawn; that one control part is not
reachable without replacing the whole control. Purely cosmetic.

---

## Limitations that are not bugs

These are design boundaries, not defects. They are in the README too, but they
belong on this page as well:

- **Workers are not patched.** `Emulation.*` (UA, timezone, locale) applies
  inside Web and Service Workers, but the JS-level patches — canvas, WebGL,
  audio — only run in the page context.
- **The font list is not randomised.** It is one of the strongest signals and
  cannot be changed without wrecking how pages look.
- **Network characteristics are untouched.** TLS/JA3, HTTP/2 header ordering and
  your IP without a proxy are all unchanged.
- **A random persona is itself a signal.** This tool is built for *session
  separation* — today's visit cannot be linked to yesterday's — not for
  disappearing. For real anonymity against a serious adversary, use Tor Browser.
- **Logging in identifies you.** Fingerprinting stops mattering the moment you
  tell a site who you are.
