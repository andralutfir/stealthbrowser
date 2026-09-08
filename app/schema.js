/**
 * Every control in the panel, described once.
 *
 * Both views render from this list, so a setting cannot exist in one and be
 * forgotten in the other, and adding an option is a line here rather than a
 * hand-built form. `path` is the dotted key in config.json - that is the only
 * link between a control and what it edits.
 *
 * kind:  select | text | textOrNull | lines | csv | bool | tri | int | intOrNull | dec
 */
window.SCHEMA = {
  simple: {
    title: 'Start a browser',
    blurb: 'Every launch opens a clean browser with a new identity and deletes everything when you '
      + 'close it. Set the few things below, then press Launch.',
    groups: [
      {
        fields: [
          { path: 'browser', label: 'Browser to use', kind: 'select', fallback: 'auto',
            options: ['auto', 'chrome', 'brave', 'edge', 'vivaldi', 'opera', 'chromium', 'downloaded'] },
          { path: 'startup.urls', label: 'Open these pages', kind: 'lines', rows: 3,
            help: 'One address per line. Each one becomes a tab.' },
          { path: 'instances.count', label: 'How many windows', kind: 'int', min: 1, max: 12, fallback: 1,
            help: 'More than one opens them side by side, each with its own identity.' },
        ],
      },
      {
        title: 'Connection',
        fields: [
          { path: 'network.interface', label: 'Go out through', kind: 'select', fallback: 'auto', dynamic: 'interfaces' },
          { path: 'network.proxy', label: 'Proxy', kind: 'textOrNull',
            placeholder: 'leave empty for none',
            help: 'http://host:port  or  socks5://user:pass@host:port' },
        ],
      },
      {
        title: 'How much data to use',
        fields: [
          { path: 'bandwidth.mode', label: 'Data saving', kind: 'select', fallback: 'off',
            options: [
              { value: 'off', label: 'off — load everything' },
              { value: 'balanced', label: 'balanced — skip ads and video' },
              { value: 'strict', label: 'strict — text first, no images' },
            ],
            help: 'Captchas are never affected, whichever one you pick.' },
        ],
      },
      {
        title: 'Identity',
        presets: true,
        fields: [],
        help: 'Full stealth hides what your browser really is. Turn it off for sites with a captcha '
          + 'or bot check that refuses to finish — you still get the clean profile.',
      },
      {
        title: 'Extras',
        fields: [
          { path: 'statusPage.enabled', label: 'Open the status tab first, so I can see what sites will be told', kind: 'bool', fallback: false },
          { path: 'debug.enabled', label: 'Keep a log of what I do in the browser', kind: 'bool', fallback: false,
            help: 'The log lands in the logs folder. It also makes some bot checks refuse the session, '
              + 'so leave it off unless you need it.' },
        ],
      },
    ],
  },

  sections: [
    {
      id: 'session', title: 'Session', blurb: 'What opens, and how the window looks.',
      groups: [{
        fields: [
          { path: 'browser', label: 'Browser', kind: 'select', fallback: 'auto',
            options: ['auto', 'chrome', 'brave', 'edge', 'vivaldi', 'opera', 'chromium', 'downloaded'],
            help: '"downloaded" is the portable browser this tool fetched. Under "auto" it is only used '
              + 'when nothing else is installed.' },
          { path: 'startup.urls', label: 'Startup URLs', kind: 'lines', rows: 4,
            help: 'One per line. Each becomes a tab.' },
          { path: 'startup.newTabUrl', label: 'New tab goes to', kind: 'textOrNull', fallback: 'about:blank',
            help: 'Where Ctrl+T lands. The built-in new tab pages are live dashboards that fetch sponsored '
              + 'content, so a disposable browser is better off without them. Leave empty to keep the '
              + "browser's own page — on Brave that also brings back a crash on Ctrl+T." },
          { path: 'startup.windowSize', label: 'Window size', kind: 'select', fallback: 'random',
            options: ['random', 'maximized', '1280x800', '1440x900', '1920x1080'], free: true },
          { path: 'startup.incognito', label: 'Add incognito on top of the disposable profile', kind: 'bool', fallback: false },
          { path: 'startup.deferUrls', label: 'Open tabs over DevTools once spoofing is armed (recommended)', kind: 'bool', fallback: true },
        ],
      }],
    },
    {
      id: 'windows', title: 'Multiple browsers',
      blurb: 'Several sessions side by side. Only the geometry is shared — identity, profile, cookies '
        + 'and proxy stay separate per instance.',
      groups: [{
        fields: [
          { path: 'instances.count', label: 'How many', kind: 'int', min: 1, max: 12, fallback: 1 },
          { path: 'instances.layout', label: 'Layout', kind: 'select', fallback: 'tile', options: ['tile', 'cascade', 'none'] },
          { path: 'instances.columns', label: 'Columns', kind: 'intOrNull', min: 0, max: 12, hint: '0 = derive from count' },
          { path: 'instances.maxPerRow', label: 'Max per row', kind: 'int', min: 1, max: 12, fallback: 6, hint: 'wrap past this many' },
          { path: 'instances.gap', label: 'Gap (px)', kind: 'int', min: 0, max: 200, fallback: 0 },
          { path: 'instances.staggerMs', label: 'Stagger (ms)', kind: 'int', min: 0, max: 10000, fallback: 700, hint: 'delay between launches' },
        ],
        help: 'Chromium refuses windows narrower than about 400px, so past 5–6 columns the windows start to overlap.',
      }],
    },
    {
      id: 'identity', title: 'Identity',
      blurb: 'A fresh persona each launch. Timezone, languages and geolocation always come from the same '
        + 'location bundle, so they never contradict each other.',
      groups: [
        { title: 'Presets', presets: true, fields: [],
          help: '"No spoof" clears every override on the Fingerprint page and stops the recorder, so nothing '
            + 'is injected into the page. You keep the disposable profile, the empty cookie jar and the '
            + 'network binding — a normal browser that forgets everything.' },
        {
          fields: [
            { path: 'identity.randomize', label: 'Randomise the identity on every launch', kind: 'bool', fallback: true },
            { path: 'identity.platform', label: 'Claimed platform', kind: 'select', fallback: 'auto',
              options: ['auto', 'windows', 'macos', 'linux'],
              help: 'auto keeps the real OS. Claiming another is far easier to detect: the GPU string follows, '
                + 'but the installed font list never does.' },
            { path: 'identity.seed', label: 'Seed', kind: 'textOrNull', hint: 'blank = new each time' },
            { path: 'identity.timezone', label: 'Timezone', kind: 'select', fallback: 'random', free: true,
              options: ['random', 'Asia/Jakarta', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul',
                'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Stockholm',
                'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney'],
              help: 'Leave on "random" and the timezone follows the persona\'s location bundle. Pinning one '
                + 'breaks that: a Swedish persona on a Tokyo clock contradicts itself.' },
            { path: 'identity.userAgent', label: 'User-Agent', kind: 'text', fallback: 'random',
              help: '"random" builds one from the real browser version.' },
            { path: 'identity.locales', label: 'Locale pool', kind: 'csv',
              help: 'Comma separated, e.g.  en-US, id-ID, ja-JP    Empty = all 18 bundles.' },
            { path: 'identity.driftVersion', label: 'Vary the browser build and patch numbers', kind: 'bool', fallback: true,
              help: 'The major version is always left truthful; feature detection catches a lie there.' },
          ],
        },
      ],
    },
    {
      id: 'fingerprint', title: 'Fingerprint surfaces', blurb: 'Which parts of the identity are actually enforced.',
      groups: [{
        fields: [
          { path: 'identity.spoof.userAgent', label: 'User-Agent, Client Hints and HTTP headers', kind: 'bool', fallback: true },
          { path: 'identity.spoof.locale', label: 'Languages (navigator.language, Accept-Language)', kind: 'bool', fallback: true },
          { path: 'identity.spoof.timezone', label: 'Timezone (Intl and getTimezoneOffset)', kind: 'bool', fallback: true },
          { path: 'identity.spoof.geolocation', label: 'Geolocation', kind: 'bool', fallback: true },
          { path: 'identity.spoof.screen', label: 'Screen metrics and devicePixelRatio', kind: 'bool', fallback: true },
          { path: 'identity.spoof.hardware', label: 'CPU cores and device memory', kind: 'bool', fallback: true },
          { path: 'identity.spoof.webgl', label: 'GPU vendor and renderer', kind: 'bool', fallback: true },
          { path: 'identity.spoof.webglNoise', label: 'WebGL readback noise', kind: 'bool', fallback: true },
          { path: 'identity.spoof.canvasNoise', label: 'Canvas fingerprint noise', kind: 'bool', fallback: true },
          { path: 'identity.spoof.audioNoise', label: 'AudioContext fingerprint noise', kind: 'bool', fallback: true },
          { path: 'identity.spoof.fontNoise', label: 'Text and element metric noise', kind: 'bool', fallback: false },
          { path: 'identity.spoof.uaDataFallback', label: 'navigator.userAgentData fallback (only without DevTools)', kind: 'bool', fallback: false },
        ],
        help: 'Metric noise is off by default: it can visibly break some layouts, and it does not hide the '
          + 'installed font list, which is never spoofed.',
      }],
    },
    {
      id: 'network', title: 'Network', blurb: 'Which adapter the traffic leaves by, and what it goes through.',
      groups: [{
        fields: [
          { path: 'network.interface', label: 'Interface', kind: 'select', fallback: 'auto', dynamic: 'interfaces',
            help: 'Pick the default route, an alias, or an adapter by name. With two of a kind the aliases are '
              + 'numbered — lan1, lan2 — so the choice is never left to luck.' },
          { path: 'network.proxy', label: 'Proxy', kind: 'textOrNull',
            help: 'http://user:pass@host:8080   or   socks5://user:pass@host:1080\n'
              + 'SOCKS5 with authentication works here even though Chromium cannot do it.' },
          { path: 'network.proxies', label: 'Proxy per instance', kind: 'lines', rows: 3,
            help: 'One per line, used in turn across instances. Overrides the single proxy above.' },
          { path: 'network.dnsServers', label: 'DNS servers', kind: 'csv', help: 'Comma separated. Empty = follow the system resolver.' },
          { path: 'network.blockWebRTC', label: 'Stop WebRTC leaking the real IP', kind: 'bool', fallback: true },
          { path: 'network.blockHosts', label: 'Blocked hosts', kind: 'lines', rows: 3,
            help: 'One per line, subdomains included. Needs the local proxy, which runs when an interface is '
              + 'pinned or a proxy is set.' },
        ],
      }],
    },
    {
      id: 'bandwidth', title: 'Bandwidth',
      blurb: 'balanced removes traffic you never look at and leaves the page intact. strict also drops '
        + 'images and web fonts.',
      groups: [
        { fields: [{ path: 'bandwidth.mode', label: 'Mode', kind: 'select', fallback: 'off', options: ['off', 'balanced', 'strict'] }] },
        {
          title: 'Overrides',
          fields: [
            { path: 'bandwidth.blockAds', label: 'Ads and trackers', kind: 'tri' },
            { path: 'bandwidth.blockMedia', label: 'Video and audio', kind: 'tri' },
            { path: 'bandwidth.blockAutoplay', label: 'Autoplay', kind: 'tri' },
            { path: 'bandwidth.blockImages', label: 'Images', kind: 'tri' },
            { path: 'bandwidth.blockFonts', label: 'Web fonts', kind: 'tri' },
            { path: 'bandwidth.saveDataHeader', label: 'Save-Data header', kind: 'tri' },
          ],
          help: '"follow mode" takes whatever the chosen mode implies.',
        },
        {
          title: 'Captchas',
          fields: [{ path: 'bandwidth.allowChallenges', label: 'Never save bandwidth inside a captcha or bot check', kind: 'bool', fallback: true }],
          help: 'hCaptcha, reCAPTCHA, Turnstile, Arkose, GeeTest, DataDome and the rest keep their images, '
            + 'fonts and audio challenge. Without this, strict mode leaves you a puzzle grid of empty boxes.',
        },
        {
          title: 'Extras',
          fields: [
            { path: 'bandwidth.extraBlockPatterns', label: 'Extra block patterns', kind: 'lines', rows: 3,
              help: 'One per line, e.g.   *.gif*    *cdn.example.com*' },
            { path: 'bandwidth.diskCacheMB', label: 'Cache size (MB)', kind: 'int', min: 0, max: 4096, fallback: 256 },
            { path: 'bandwidth.report', label: 'Report how much was downloaded when the session ends', kind: 'bool', fallback: true },
          ],
        },
      ],
    },
    {
      id: 'status', title: 'Status tab',
      blurb: 'A local summary as the first tab: the identity in use, what websites actually see, and the '
        + 'current public IP.',
      groups: [
        {
          fields: [
            { path: 'statusPage.enabled', label: 'Open the status tab first', kind: 'bool', fallback: false },
            { path: 'statusPage.mode', label: 'Opens in', kind: 'select', fallback: 'advanced',
              options: [
                { value: 'simple', label: 'simple — a verdict and the session in sentences' },
                { value: 'advanced', label: 'advanced — the full side-by-side check' },
              ] },
            { path: 'statusPage.checkIp', label: 'Look up the public IP on that page', kind: 'bool', fallback: true },
            { path: 'statusPage.ipService', label: 'IP service', kind: 'text', fallback: 'https://ipinfo.io/json' },
            { path: 'statusPage.ipFallback', label: 'Fallback', kind: 'text', fallback: 'https://api.ipify.org?format=json' },
          ],
          help: 'The lookup runs from inside the browser, so it reflects the interface and proxy this session '
            + 'is actually using. Turn it off for no outbound request.',
        },
        {
          title: 'IP quality',
          fields: [
            { path: 'statusPage.checkQuality', label: 'Score how a website is likely to judge this address', kind: 'bool', fallback: true },
            { path: 'statusPage.qualityService', label: 'Quality service', kind: 'text' },
          ],
          help: 'Starts at 100 and subtracts what the lookup reports: a datacenter range or a flagged proxy '
            + 'costs the most, a mobile CGNAT address a little, and a browser timezone that disagrees with '
            + "the IP's costs too. Every deduction is listed with its weight.",
        },
      ],
    },
    {
      id: 'recording', title: 'Session recording',
      blurb: 'Records clicks, typing, dropdowns, forms, keys, scrolling and navigation into a readable .log, '
        + 'a structured .jsonl, and a browsable HTML timeline.',
      groups: [
        {
          fields: [
            { path: 'debug.enabled', label: 'Record the session', kind: 'bool', fallback: false },
            { path: 'debug.level', label: 'Detail level', kind: 'select', fallback: 'info', options: ['error', 'warn', 'info', 'debug'] },
            { path: 'debug.console', label: 'Mirror log lines into the output pane', kind: 'bool', fallback: true },
          ],
        },
        {
          title: 'What to capture',
          fields: [
            { path: 'debug.interactions', label: 'Interactions (clicks, typing, forms)', kind: 'bool', fallback: true },
            { path: 'debug.captureConsole', label: 'Page console output', kind: 'bool', fallback: true },
            { path: 'debug.network', label: 'Network requests and responses', kind: 'bool', fallback: true },
            { path: 'debug.browserLogs', label: 'Browser warnings (CSP, mixed content)', kind: 'bool', fallback: true },
            { path: 'debug.captureKeys', label: 'Named keys and shortcuts', kind: 'bool', fallback: true },
            { path: 'debug.captureScroll', label: 'Scroll depth milestones', kind: 'bool', fallback: true },
          ],
        },
        {
          title: 'Field values',
          fields: [
            { path: 'debug.captureValues', label: 'Record what was typed into each field', kind: 'bool', fallback: true },
            { path: 'debug.redactSecrets', label: 'Keep password and credential fields masked', kind: 'bool', fallback: true },
            { path: 'debug.maxValueLength', label: 'Max value length', kind: 'int', min: 20, max: 4000, fallback: 200 },
            { path: 'debug.typeIdleMs', label: 'Typing pause (ms)', kind: 'int', min: 100, max: 5000, fallback: 900, hint: 'one entry per field' },
          ],
          warn: 'Unchecking the mask writes real passwords into a plain text file on disk. Only do that deliberately.',
        },
        {
          title: 'Output',
          fields: [
            { path: 'debug.jsonl', label: 'Write the .jsonl structured sidecar', kind: 'bool', fallback: true },
            { path: 'debug.htmlReport', label: 'Write the HTML timeline', kind: 'bool', fallback: true },
            { path: 'debug.logDir', label: 'Log folder', kind: 'text', fallback: 'logs' },
          ],
        },
      ],
    },
    {
      id: 'macro', title: 'Macro replay',
      blurb: 'Point this at a recording and the session performs it again: same clicks, same text in the '
        + 'same fields, same submits, in the same order.',
      groups: [{
        fields: [
          { path: 'macro.file', label: 'Macro file', kind: 'textOrNull',
            help: 'Any .jsonl from a recorded session works directly. Leave empty to not replay.' },
          { path: 'macro.speed', label: 'Speed', kind: 'dec', min: 0, max: 10, fallback: 1, hint: '1 = as recorded' },
          { path: 'macro.maxDelayMs', label: 'Max wait between steps', kind: 'int', min: 0, max: 60000, fallback: 3000 },
          { path: 'macro.waitForMs', label: 'Wait for element (ms)', kind: 'int', min: 500, max: 120000, fallback: 10000 },
          { path: 'macro.stopOnMissing', label: 'Stop at the first step that cannot be performed', kind: 'bool', fallback: false },
        ],
        help: 'Fields the recording masked cannot be replayed. Supply them under "macro": { "secrets": '
          + '{ "#password": "..." } } in config.json.',
      }],
    },
    {
      id: 'privacy', title: 'Privacy',
      blurb: 'Every launch uses a throwaway profile and deletes it on exit: cookies, cache, history, '
        + 'localStorage and service workers all go with it.',
      groups: [
        {
          fields: [
            { path: 'privacy.wipeOnExit', label: 'Delete the profile when the browser closes', kind: 'bool', fallback: true },
            { path: 'privacy.profileRoot', label: 'Profile folder', kind: 'textOrNull', help: 'Empty = the OS temp folder.' },
          ],
        },
        {
          title: 'Browser behaviour',
          fields: [
            { path: 'privacy.blockThirdPartyCookies', label: 'Block third-party cookies', kind: 'bool', fallback: true },
            { path: 'privacy.doNotTrack', label: 'Send Do Not Track', kind: 'bool', fallback: true },
            { path: 'privacy.disableSync', label: 'Disable sync and sign-in', kind: 'bool', fallback: true },
            { path: 'privacy.disableBackgroundNetworking', label: 'Disable background networking', kind: 'bool', fallback: true },
            { path: 'privacy.disablePrivacySandbox', label: 'Disable the Privacy Sandbox APIs', kind: 'bool', fallback: true },
            { path: 'privacy.blockGeolocation', label: 'Block geolocation requests', kind: 'bool', fallback: true },
            { path: 'privacy.blockSensors', label: 'Block motion and light sensors', kind: 'bool', fallback: true },
            { path: 'privacy.safeBrowsing', label: 'Enable Safe Browsing (sends URL hashes to Google)', kind: 'bool', fallback: false },
          ],
        },
      ],
    },
    {
      id: 'advanced', title: 'Advanced', blurb: 'Extras that are passed straight through to the browser.',
      groups: [
        {
          fields: [
            { path: 'extensions', label: 'Extensions', kind: 'lines', rows: 3, help: 'One unpacked extension folder per line (not .crx files).' },
            { path: 'flags', label: 'Chromium flags', kind: 'csv', help: 'Comma separated, e.g.  --force-dark-mode, --mute-audio' },
            { path: 'verbose', label: 'Verbose launcher internals (proxy, CDP, cleanup)', kind: 'bool', fallback: false },
          ],
        },
        {
          title: 'Getting a browser',
          fields: [
            { path: 'downloadBrowser.auto', label: 'Fetch one automatically when nothing is installed', kind: 'bool', fallback: true },
            { path: 'downloadBrowser.channel', label: 'Channel', kind: 'select', fallback: 'Stable', options: ['Stable', 'Beta', 'Dev', 'Canary'] },
            { path: 'downloadBrowser.dir', label: 'Download folder', kind: 'text', fallback: 'browsers' },
          ],
        },
      ],
    },
  ],
};
