// The StealthBrowser window: dark shell, animated navigation, and the
// data-driven settings surface that maps one-to-one onto config.json.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.NetworkInformation;
using System.Text;
using System.Windows.Forms;

namespace StealthBrowser
{
    public class MainForm : Form
    {
        private readonly string _root;
        private readonly ConfigModel _cfg = new ConfigModel();
        private readonly List<Process> _running = new List<Process>();
        private readonly List<Field> _fields = new List<Field>();
        private readonly Dictionary<string, ScrollHost> _pages = new Dictionary<string, ScrollHost>();

        private NavPanel _nav;
        private Panel _host;
        private ConsolePane _console;
        private SplitContainer _split;
        private FlatButton _launch, _stop;
        private Label _status;
        private Animator _pageSlide;
        private ScrollHost _current;
        private Animator _logSlide;
        private FlatButton _logToggle;
        private FlatButton _simpleBtn, _advancedBtn;
        /// <summary>"simple" or "advanced" - which view is on screen.</summary>
        private string _mode = "advanced";
        private int _lastSection;
        private bool _logOpen;
        private int _baseHeight;      // window height with the log hidden
        private int _logFrom, _logTo;
        private int _topFrom, _topTo;
        private int _topBeforeGrow, _topAfterGrow;
        private bool _shiftedUp;      // we moved the window to make the log fit
        private bool _resizingLog;

        /// <summary>
        /// Anything the launcher wrote to stderr during the current run.
        /// A failure buried in a log pane that starts hidden is a failure nobody
        /// sees, so these are raised in a dialog when the run ends.
        /// </summary>
        private readonly List<string> _runErrors = new List<string>();

        private static readonly char[] LineBreaks = { '\r', '\n' };

        /// <summary>Which launch this is, when more than one runs at once.</summary>
        private int _runSeq;

        /// <summary>How much taller the window gets when the log is shown.</summary>
        private const int LogPaneHeight = 250;

        private static readonly string[] Sections = {
            "Session", "Windows", "Identity", "Fingerprint", "Network",
            "Bandwidth", "Status page", "Recording", "Macro", "Privacy", "Advanced",
        };

        public MainForm()
        {
            _root = FindRoot();
            Text = "Stealth Browser";
            // Sized for the settings alone; the log adds its own height when shown.
            Size = new Size(1080, 700);
            MinimumSize = new Size(960, 560);
            _baseHeight = 700;
            StartPosition = FormStartPosition.CenterScreen;
            Font = Theme.UI();
            BackColor = Theme.Bg;
            ForeColor = Theme.Text;

            BuildUi();
            LoadConfig();

            FormClosing += (s, e) => StopAll();
            HandleCreated += (s, e) => Native.UseDarkTitleBar(Handle);
            Shown += (s, e) =>
            {
                Native.UseDarkTitleBar(Handle);
                // The log starts hidden: most of the time the settings are what
                // you came for, and the pane can be summoned when it matters.
                ToggleLog(false, false);
                SetMode(_cfg.GetString("gui.mode", "advanced"));
                // Final pass: if anything in the layout or load path put system
                // colours back, this is after all of it.
                foreach (var f in _fields) Darken(f.Ctl);
            };
        }

        private static string FindRoot()
        {
            var dir = AppDomain.CurrentDomain.BaseDirectory;
            for (int i = 0; i < 4 && dir != null; i++)
            {
                if (File.Exists(Path.Combine(dir, "src", "index.js"))) return dir.TrimEnd('\\');
                var parent = Directory.GetParent(dir.TrimEnd('\\'));
                dir = parent == null ? null : parent.FullName;
            }
            return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        }

        // -------------------------------------------------------------- shell

        private void BuildUi()
        {
            _host = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Panel };

            _nav = new NavPanel(Sections) { Dock = DockStyle.Left, Width = 186 };
            _nav.Selected += (i) => ShowSection(i, true);

            foreach (var name in Sections)
            {
                var host = new ScrollHost { Dock = DockStyle.Fill, Visible = false };
                _pages[name] = host;
                _host.Controls.Add(host);
            }
            BuildSession(_pages["Session"]);
            BuildWindows(_pages["Windows"]);
            BuildIdentity(_pages["Identity"]);
            BuildFingerprint(_pages["Fingerprint"]);
            BuildNetwork(_pages["Network"]);
            BuildBandwidth(_pages["Bandwidth"]);
            BuildStatusPage(_pages["Status page"]);
            BuildRecording(_pages["Recording"]);
            BuildMacro(_pages["Macro"]);
            BuildPrivacy(_pages["Privacy"]);
            BuildAdvanced(_pages["Advanced"]);

            // The plain view. It writes the same config.json - it just stops at
            // the eight settings that decide how a session actually behaves.
            var simple = new ScrollHost { Dock = DockStyle.Fill, Visible = false };
            _pages["Simple"] = simple;
            _host.Controls.Add(simple);
            _fieldMode = "simple";
            BuildSimple(simple);
            _fieldMode = "advanced";

            var body = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Panel };
            body.Controls.Add(_host);
            body.Controls.Add(_nav);

            _console = new ConsolePane { Dock = DockStyle.Fill };

            _split = new SplitContainer
            {
                Dock = DockStyle.Fill, Orientation = Orientation.Horizontal,
                // Panel2 collapses to nothing, so the log can be hidden entirely.
                Panel1MinSize = 200, Panel2MinSize = 0, BackColor = Theme.Line, SplitterWidth = 4,
            };
            _split.Panel1.Controls.Add(body);
            _split.Panel2.Controls.Add(_console);

            Controls.Add(_split);
            Controls.Add(BuildActionBar());
            Controls.Add(BuildStatusBar());
            Controls.Add(BuildHeader());

            _pageSlide = new Animator(v =>
            {
                if (_current != null) _current.Content.Left = (int)Math.Round((1 - v) * 26);
            });

            // Showing the log grows the window rather than squeezing the
            // settings, so hiding it costs no screen space at all.
            _split.FixedPanel = FixedPanel.Panel1;
            _split.Panel2Collapsed = true;
            // Height and position move together in one SetBounds, so a window
            // that has to slide up to stay clear of the taskbar does it without
            // a visible two-step.
            _logSlide = new Animator(v =>
            {
                try
                {
                    var h = (int)Math.Round(_logFrom + (_logTo - _logFrom) * v);
                    var t = (int)Math.Round(_topFrom + (_topTo - _topFrom) * v);
                    SetBounds(Left, t, Width, h);
                }
                catch { }
            });

            Resize += (s, e) =>
            {
                // Track the user's own sizing, but only while the log is hidden
                // and we are not the ones moving the window.
                if (!_logOpen && !_resizingLog && WindowState == FormWindowState.Normal)
                    _baseHeight = Height;
            };
        }

        private Control BuildHeader()
        {
            var p = new Panel { Dock = DockStyle.Top, Height = 68, BackColor = Theme.Bg };
            p.Paint += (s, e) =>
            {
                using (var pen = new Pen(Theme.Line))
                    e.Graphics.DrawLine(pen, 0, p.Height - 1, p.Width, p.Height - 1);
            };
            p.Controls.Add(new Label
            {
                Text = "Stealth Browser", ForeColor = Theme.Text, AutoSize = true,
                Font = Theme.Display(15f), Location = new Point(20, 11), BackColor = Color.Transparent,
            });
            p.Controls.Add(new Label
            {
                Text = "A disposable browser: a new profile and a new identity every time it opens.",
                ForeColor = Theme.Dim, AutoSize = true, Font = Theme.UI(9f),
                Location = new Point(22, 40), BackColor = Color.Transparent,
            });

            var credit = new Label
            {
                Text = "Copyright by Andra Lutfi Ridhotullah",
                ForeColor = Theme.Faint, AutoSize = false, Size = new Size(340, 20),
                TextAlign = ContentAlignment.MiddleRight, Font = Theme.UI(8.5f),
                BackColor = Color.Transparent, Anchor = AnchorStyles.Top | AnchorStyles.Right,
            };
            p.Controls.Add(credit);

            _simpleBtn = Btn("Simple", 72, () => SetMode("simple"));
            _advancedBtn = Btn("Advanced", 82, () => SetMode("advanced"));
            _simpleBtn.Height = 26;
            _advancedBtn.Height = 26;
            p.Controls.Add(_simpleBtn);
            p.Controls.Add(_advancedBtn);

            // Anchor alone misplaces them before the first layout pass.
            Action place = () =>
            {
                _advancedBtn.Location = new Point(p.Width - _advancedBtn.Width - 20, 10);
                _simpleBtn.Location = new Point(_advancedBtn.Left - _simpleBtn.Width - 6, 10);
                credit.Location = new Point(p.Width - credit.Width - 20, 42);
            };
            place();
            p.Resize += (s, e) => place();
            return p;
        }

        private Control BuildStatusBar()
        {
            _status = new Label
            {
                Dock = DockStyle.Bottom, Height = 26, Padding = new Padding(14, 6, 12, 0),
                ForeColor = Theme.Dim, BackColor = Theme.Bg, Font = Theme.UI(8.75f),
            };
            return _status;
        }

        private Control BuildActionBar()
        {
            var bar = new FlowLayoutPanel
            {
                Dock = DockStyle.Bottom, Height = 52, Padding = new Padding(14, 10, 10, 10),
                BackColor = Theme.Bg,
            };
            bar.Paint += (s, e) =>
            {
                using (var pen = new Pen(Theme.Line)) e.Graphics.DrawLine(pen, 0, 0, bar.Width, 0);
            };

            _launch = Btn("Launch browser", 132, () => Launch(), true);
            _stop = Btn("Stop all", 78, () => StopAll());
            _stop.Enabled = false;

            bar.Controls.Add(_launch);
            bar.Controls.Add(_stop);
            bar.Controls.Add(Btn("Save", 64, () => { if (SaveConfig()) Info("Saved to " + _cfg.SourceFile); }));
            bar.Controls.Add(Btn("Reload", 68, () => LoadConfig()));
            bar.Controls.Add(Btn("Check setup", 94, () => RunTool("--check")));
            bar.Controls.Add(Btn("Get browser", 92, () => RunStreaming("--install-browser Stable",
                "Downloading a portable Chrome - about 190 MB, nothing is installed.")));
            bar.Controls.Add(Btn("Preview identity", 114, () => RunTool("--print-identity")));
            bar.Controls.Add(Btn("Logs", 56, () => OpenFolder("logs")));
            bar.Controls.Add(Btn("Macros", 66, () => OpenFolder("macros")));
            bar.Controls.Add(Btn("Clear", 58, () => _console.Clear()));
            _logToggle = Btn("Show log", 78, () => ToggleLog(!_logOpen));
            bar.Controls.Add(_logToggle);
            return bar;
        }

        private FlatButton Btn(string text, int width, Action onClick, bool primary = false)
        {
            var b = new FlatButton(text, width, primary) { Margin = new Padding(0, 0, 7, 0) };
            b.Click += (s, e) => onClick();
            return b;
        }

        /// <summary>
        /// Swap between the plain view and the full one.
        ///
        /// Both write the same config.json, so whatever the view being left had
        /// on screen is read back first and the arriving view is filled from it.
        /// Otherwise a change made in one would be lost the moment you switched.
        /// </summary>
        private void SetMode(string mode)
        {
            var next = mode == "simple" ? "simple" : "advanced";
            if (_simpleBtn != null) _simpleBtn.Primary = next == "simple";
            if (_advancedBtn != null) _advancedBtn.Primary = next == "advanced";
            if (_simpleBtn != null) _simpleBtn.Invalidate();
            if (_advancedBtn != null) _advancedBtn.Invalidate();

            if (next == _mode && _current != null) return;

            CollectActive();
            _mode = next;
            foreach (var f in _fields)
            {
                try { Apply(f); }
                catch { /* a value the other view cannot show is not fatal */ }
            }

            if (next == "simple")
            {
                _nav.Visible = false;
                var page = _pages["Simple"];
                foreach (var kv in _pages) kv.Value.Visible = kv.Value == page;
                _current = page;
                page.ResetScroll();
                page.Content.Left = 0;
            }
            else
            {
                _nav.Visible = true;
                _current = null;                 // force ShowSection to redraw
                ShowSection(_lastSection, false);
            }
            foreach (var f in _fields) Darken(f.Ctl);
        }

        /// <summary>Switch section, sliding the new page in from the right.</summary>
        private void ShowSection(int index, bool animate)
        {
            if (index < 0 || index >= Sections.Length) return;
            var next = _pages[Sections[index]];
            if (_current == next) return;
            foreach (var kv in _pages) kv.Value.Visible = kv.Value == next;
            _lastSection = index;
            _nav.SetIndex(index);
            _current = next;
            next.ResetScroll();
            if (animate) { _pageSlide.Set(0); _pageSlide.To(1, 210); }
            else { next.Content.Left = 0; }
        }

        // ------------------------------------------------------ field helpers

        private int _y;
        private ScrollHost _building;
        /// <summary>Which view the controls being built right now belong to.</summary>
        private string _fieldMode = "advanced";

        private Panel Begin(ScrollHost host)
        {
            _building = host;
            _y = 14;
            return host.Content;
        }

        private void End()
        {
            _building.Recalculate(_y + 24);
        }

        private void Head(Panel p, string title, string blurb)
        {
            p.Controls.Add(new Label
            {
                Text = title, AutoSize = true, ForeColor = Theme.Text,
                Font = Theme.Display(15f), Location = new Point(22, _y), BackColor = Color.Transparent,
            });
            _y += 30;
            if (blurb != null)
            {
                var lines = blurb.Split('\n').Length;
                p.Controls.Add(new Label
                {
                    Text = blurb, ForeColor = Theme.Dim, AutoSize = false,
                    Size = new Size(720, lines * 17 + 2), Location = new Point(23, _y),
                    BackColor = Color.Transparent, Font = Theme.UI(9f),
                });
                _y += lines * 17 + 10;
            }
            _y += 6;
        }

        private void Group(Panel p, string title)
        {
            _y += 12;
            p.Controls.Add(new Label
            {
                Text = title.ToUpperInvariant(), AutoSize = true, ForeColor = Theme.Faint,
                Font = Theme.UI(8f, FontStyle.Bold), Location = new Point(23, _y), BackColor = Color.Transparent,
            });
            _y += 22;
        }

        /// <summary>Lay a row of buttons across the page and advance past it.</summary>
        private void ButtonRow(Panel p, params FlatButton[] buttons)
        {
            var x = 23;
            var h = 0;
            foreach (var b in buttons)
            {
                b.Location = new Point(x, _y);
                p.Controls.Add(b);
                x += b.Width + 9;
                h = Math.Max(h, b.Height);
            }
            _y += h + 11;
        }

        private void Note(Panel p, string text, bool warn = false)
        {
            var lines = text.Split('\n').Length;
            p.Controls.Add(new Label
            {
                Text = text, ForeColor = warn ? Theme.Warn : Theme.Faint, AutoSize = false,
                Size = new Size(700, lines * 16 + 3), Location = new Point(23, _y),
                BackColor = Color.Transparent, Font = Theme.UI(8.75f),
            });
            _y += lines * 16 + 11;
        }

        private void Row(Panel p, string label, Control ctl, string path, string kind, object fallback = null, string hint = null)
        {
            if (label != null)
            {
                p.Controls.Add(new Label
                {
                    Text = label, AutoSize = false, Size = new Size(178, 22),
                    Location = new Point(23, _y + 4), ForeColor = Theme.Dim,
                    BackColor = Color.Transparent, Font = Theme.UI(9.25f),
                });
            }
            var placed = Frame(ctl);
            placed.Location = new Point(label == null ? 23 : 206, _y);
            p.Controls.Add(placed);
            Darken(ctl);
            if (path != null) _fields.Add(new Field { Path = path, Ctl = ctl, Kind = kind, Fallback = fallback, Mode = _fieldMode });

            if (hint != null)
            {
                p.Controls.Add(new Label
                {
                    Text = hint, ForeColor = Theme.Faint, AutoSize = false,
                    Size = new Size(280, 18), Location = new Point(206 + placed.Width + 14, _y + 5),
                    BackColor = Color.Transparent, Font = Theme.UI(8.75f),
                });
            }
            _y += placed.Height + 9;
        }

        private static DarkCheck Chk(string text) { return new DarkCheck(text); }

        /// <summary>Paint combo rows dark; WinForms will not theme them for us.</summary>
        private static void DrawCombo(object sender, DrawItemEventArgs e)
        {
            var cb = (ComboBox)sender;
            var selected = (e.State & DrawItemState.Selected) == DrawItemState.Selected;
            using (var b = new SolidBrush(selected ? Theme.AccentDim : Theme.Input))
                e.Graphics.FillRectangle(b, e.Bounds);
            if (e.Index >= 0)
            {
                TextRenderer.DrawText(e.Graphics, cb.Items[e.Index].ToString(), cb.Font,
                    new Rectangle(e.Bounds.X + 4, e.Bounds.Y, e.Bounds.Width - 6, e.Bounds.Height),
                    Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            }
        }

        /// <summary>
        /// Wrap a bordered input in a drawn frame and make the control itself
        /// borderless. A borderless TextBox honours BackColor reliably; the
        /// themed FixedSingle border is what drags the system colours back in.
        /// </summary>
        private static Control Frame(Control ctl)
        {
            var tb = ctl as TextBox;
            var nud = ctl as NumericUpDown;
            if (tb == null && nud == null) return ctl;

            if (tb != null) tb.BorderStyle = BorderStyle.None;
            if (nud != null) nud.BorderStyle = BorderStyle.None;

            var pad = 5;
            var frame = new Panel
            {
                Width = ctl.Width + pad * 2,
                Height = ctl.Height + pad * 2,
                BackColor = Theme.Input,
            };
            ctl.Location = new Point(pad, pad);
            frame.Controls.Add(ctl);
            frame.Paint += (s, e) =>
            {
                using (var pen = new Pen(Theme.Line))
                    e.Graphics.DrawRectangle(pen, 0, 0, frame.Width - 1, frame.Height - 1);
            };
            return frame;
        }

        /// <summary>Force the dark palette onto a native input and its children.</summary>
        private static void Darken(Control c)
        {
            if (c is TextBox || c is ComboBox || c is NumericUpDown)
            {
                c.BackColor = Theme.Input;
                c.ForeColor = Theme.Text;
                // NumericUpDown hosts its own edit box, which keeps system colours.
                foreach (Control child in c.Controls)
                {
                    child.BackColor = Theme.Input;
                    child.ForeColor = Theme.Text;
                }
            }
        }

        private static ComboBox Cmb(int width, params string[] items)
        {
            var c = new ComboBox
            {
                Width = width, DropDownStyle = ComboBoxStyle.DropDownList, FlatStyle = FlatStyle.Flat,
                DrawMode = DrawMode.OwnerDrawFixed, ItemHeight = 20,
                BackColor = Theme.Input, ForeColor = Theme.Text, Font = Theme.UI(),
            };
            c.Items.AddRange(items);
            c.DrawItem += DrawCombo;
            return c;
        }

        private static ComboBox Tri()
        {
            var c = new ComboBox
            {
                Width = 158, DropDownStyle = ComboBoxStyle.DropDownList, FlatStyle = FlatStyle.Flat,
                DrawMode = DrawMode.OwnerDrawFixed, ItemHeight = 20,
                BackColor = Theme.Input, ForeColor = Theme.Text, Font = Theme.UI(),
            };
            c.Items.AddRange(new object[] { "follow mode", "on", "off" });
            c.DrawItem += DrawCombo;
            return c;
        }

        private static TextBox Txt(int width)
        {
            return new TextBox
            {
                Width = width, BackColor = Theme.Input, ForeColor = Theme.Text,
                BorderStyle = BorderStyle.FixedSingle, Font = Theme.UI(),
            };
        }

        private static TextBox Area(int width, int height)
        {
            return new TextBox
            {
                Width = width, Height = height, Multiline = true, ScrollBars = ScrollBars.Vertical,
                BackColor = Theme.Input, ForeColor = Theme.Text,
                BorderStyle = BorderStyle.FixedSingle, Font = Theme.Mono(8.75f),
            };
        }

        private static NumericUpDown Num(int min, int max, int decimals = 0)
        {
            return new NumericUpDown
            {
                Minimum = min, Maximum = max, Width = 96, DecimalPlaces = decimals,
                Increment = decimals > 0 ? 0.5m : 1m,
                BackColor = Theme.Input, ForeColor = Theme.Text,
                BorderStyle = BorderStyle.FixedSingle, Font = Theme.UI(),
            };
        }

        // -------------------------------------------------------------- pages

        /// <summary>
        /// Everything a session needs, in one page and in plain words. The
        /// remaining options all have defaults that work; Advanced is where they
        /// live for the times they do not.
        /// </summary>
        private void BuildSimple(ScrollHost h)
        {
            var p = Begin(h);
            Head(p, "Start a browser",
                "Every launch opens a clean browser with a new identity, and deletes everything\nwhen you close it. Set the few things below and press Launch browser.");

            Row(p, "Browser to use",
                Cmb(230, "auto", "chrome", "brave", "edge", "vivaldi", "opera", "chromium", "downloaded"),
                "browser", "text", "auto");
            Row(p, "Open these pages", Area(430, 70), "startup.urls", "lines");
            Note(p, "One address per line. Each one becomes a tab.");
            Row(p, "How many windows", Num(1, 12), "instances.count", "int", 1);
            Note(p, "More than one opens them side by side, each with its own identity.");

            Group(p, "Connection");
            var iface = Cmb(300);
            foreach (var c in InterfaceChoices()) iface.Items.Add(c);
            Row(p, "Go out through", iface, "network.interface", "text", "auto");
            Row(p, "Proxy", Txt(360), "network.proxy", "textOrNull", "", "leave empty for none");
            Note(p, "http://host:port  or  socks5://user:pass@host:port");

            Group(p, "How much data to use");
            var saving = Cmb(300);
            saving.Items.Add(new ComboItem("off", "off  -  load everything"));
            saving.Items.Add(new ComboItem("balanced", "balanced  -  skip ads and video"));
            saving.Items.Add(new ComboItem("strict", "strict  -  text first, no images"));
            Row(p, "Data saving", saving, "bandwidth.mode", "text", "off");
            Note(p, "Captchas are never affected, whichever one you pick.");

            Group(p, "Identity");
            ButtonRow(p,
                Btn("Full stealth", 106, () => ApplyPreset(true)),
                Btn("No spoof", 88, () => ApplyPreset(false)));
            Note(p, "Full stealth hides what your browser really is. Turn it off for sites with a\n"
                  + "captcha or bot check that refuses to finish - you still get the clean profile.");

            Group(p, "Extras");
            Row(p, null, Chk("Open the status tab first, so I can see what sites will be told"),
                "statusPage.enabled", "bool", false);
            Row(p, null, Chk("Keep a log of what I do in the browser"), "debug.enabled", "bool", false);
            Note(p, "The log lands in the logs folder. It also makes some bot checks refuse the\nsession, so leave it off unless you need it.");
            End();
        }

        private void BuildSession(ScrollHost h)
        {
            var p = Begin(h);
            Head(p, "Session", "What opens, and how the window looks.");
            Row(p, "Browser", Cmb(250, "auto", "chrome", "brave", "edge", "vivaldi", "opera", "chromium", "downloaded"), "browser", "text", "auto");
            Note(p, "\"downloaded\" is the portable Chrome this tool fetched with Get browser.\nUnder \"auto\" it is only used when nothing else is installed.");
            Row(p, "Startup URLs", Area(430, 88), "startup.urls", "lines");
            Note(p, "One per line. Each becomes a tab.");
            Row(p, "New tab goes to", Txt(310), "startup.newTabUrl", "textOrNull", "about:blank");
            Note(p, "Where Ctrl+T lands. The built-in new tab pages are live dashboards that fetch\nsponsored content, so a disposable browser is better off without them.\nLeave empty to keep the browser's own page.");
            Row(p, "Window size", Cmb(210, "random", "maximized", "1280x800", "1440x900", "1920x1080"), "startup.windowSize", "text", "random");
            Row(p, null, Chk("Add incognito on top of the disposable profile"), "startup.incognito", "bool", false);
            Row(p, null, Chk("Open tabs over DevTools once spoofing is armed (recommended)"), "startup.deferUrls", "bool", true);
            End();
        }

        private void BuildWindows(ScrollHost h)
        {
            var p = Begin(h);
            Head(p, "Multiple browsers", "Several sessions side by side. Only the geometry is shared - identity,\nprofile, cookies and proxy stay separate per instance.");
            Row(p, "How many", Num(1, 12), "instances.count", "int", 1);
            Row(p, "Layout", Cmb(210, "tile", "cascade", "none"), "instances.layout", "text", "tile");
            Row(p, "Columns", Num(0, 12), "instances.columns", "intOrNull", 0, "0 = derive from count");
            Row(p, "Max per row", Num(1, 12), "instances.maxPerRow", "int", 6, "wrap past this many");
            Row(p, "Gap (px)", Num(0, 200), "instances.gap", "int", 0);
            Row(p, "Stagger (ms)", Num(0, 10000), "instances.staggerMs", "int", 700, "delay between launches");
            Note(p, "Chromium refuses windows narrower than about 400px, so past 5-6 columns\nthe windows start to overlap.");
            End();
        }

        private void BuildIdentity(ScrollHost h)
        {
            var p = Begin(h);
            Head(p, "Identity", "A fresh persona each launch. Timezone, languages and geolocation always\ncome from the same location bundle, so they never contradict each other.");

            Group(p, "Presets");
            ButtonRow(p,
                Btn("Full stealth", 106, () => ApplyPreset(true)),
                Btn("No spoof", 88, () => ApplyPreset(false)));
            Note(p, "\"No spoof\" clears every override on the Fingerprint page and stops the recorder,\n"
                  + "so nothing is injected into the page and DevTools only opens the tab. You keep the\n"
                  + "disposable profile, the empty cookie jar and the network binding - it is a normal\n"
                  + "browser that forgets everything. Use it where a bot check refuses an instrumented one.");

            Row(p, null, Chk("Randomise the identity on every launch"), "identity.randomize", "bool", true);
            Row(p, "Claimed platform", Cmb(210, "auto", "windows", "macos", "linux"), "identity.platform", "text", "auto");
            Note(p, "auto keeps the real OS. Claiming another is far easier to detect, because\nfonts and GPU do not follow.");
            Row(p, "Seed", Txt(310), "identity.seed", "textOrNull", "", "blank = new each time");
            Row(p, "Timezone", Cmb(250, "random", "Asia/Jakarta", "Asia/Singapore", "Asia/Tokyo", "Asia/Seoul",
                "Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Stockholm",
                "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney"), "identity.timezone", "text", "random");
            Row(p, "User-Agent", Txt(430), "identity.userAgent", "text", "random");
            Note(p, "\"random\" builds one from the real browser version.");
            Row(p, "Locale pool", Txt(430), "identity.locales", "csv");
            Note(p, "Comma separated, e.g.  en-US, id-ID, ja-JP    Empty = all 18 bundles.");
            Row(p, null, Chk("Vary the browser build and patch numbers"), "identity.driftVersion", "bool", true);
            Note(p, "The major version is always left truthful; feature detection catches a lie there.");
            End();
        }

        private void BuildFingerprint(ScrollHost h)
        {
            var p = Begin(h);
            Head(p, "Fingerprint surfaces", "Which parts of the identity are actually enforced.");
            Row(p, null, Chk("User-Agent, Client Hints and HTTP headers"), "identity.spoof.userAgent", "bool", true);
            Row(p, null, Chk("Languages (navigator.language, Accept-Language)"), "identity.spoof.locale", "bool", true);
            Row(p, null, Chk("Timezone (Intl and getTimezoneOffset)"), "identity.spoof.timezone", "bool", true);
            Row(p, null, Chk("Geolocation"), "identity.spoof.geolocation", "bool", true);
            Row(p, null, Chk("Screen metrics and devicePixelRatio"), "identity.spoof.screen", "bool", true);
            Row(p, null, Chk("CPU cores and device memory"), "identity.spoof.hardware", "bool", true);
            Row(p, null, Chk("GPU vendor and renderer"), "identity.spoof.webgl", "bool", true);
            Row(p, null, Chk("WebGL readback noise"), "identity.spoof.webglNoise", "bool", true);
            Row(p, null, Chk("Canvas fingerprint noise"), "identity.spoof.canvasNoise", "bool", true);
            Row(p, null, Chk("AudioContext fingerprint noise"), "identity.spoof.audioNoise", "bool", true);
            Row(p, null, Chk("Text and element metric noise"), "identity.spoof.fontNoise", "bool", false);
            Note(p, "Metric noise is off by default: it can visibly break some layouts.", true);
            End();
        }

        private void BuildNetwork(ScrollHost h)
        {
            var p = Begin(h);
            Head(p, "Network", "Which adapter the traffic leaves by, and what it goes through.");
            var iface = Cmb(430);
            foreach (var c in InterfaceChoices()) iface.Items.Add(c);
            Row(p, "Interface", iface, "network.interface", "text", "auto");
            Note(p, "Pick the default route, an alias, or an adapter by name. With two of a kind\nthe aliases are numbered - lan1, lan2 - so the choice is never left to luck.\nA source IP works too if you type one into config.json.");
            Row(p, "Proxy", Txt(430), "network.proxy", "textOrNull", "");
            Note(p, "http://user:pass@host:8080   or   socks5://user:pass@host:1080\nSOCKS5 with authentication works here even though Chromium cannot do it.");
            Row(p, "Proxy per instance", Area(430, 64), "network.proxies", "lines");
            Note(p, "One per line, used in turn across instances. Overrides the single proxy above.");
            Row(p, "DNS servers", Txt(430), "network.dnsServers", "csv");
            Note(p, "Comma separated. Empty = follow the system resolver.");
            Row(p, null, Chk("Stop WebRTC leaking the real IP"), "network.blockWebRTC", "bool", true);
            Row(p, "Blocked hosts", Area(430, 64), "network.blockHosts", "lines");
            Note(p, "One per line, subdomains included. Needs the local proxy, which runs when an\ninterface is pinned or a proxy is set.");
            End();
        }

        private void BuildBandwidth(ScrollHost h)
        {
            var p = Begin(h);
            Head(p, "Bandwidth", "balanced removes traffic you never look at and leaves the page intact.\nstrict also drops images and web fonts.");
            Row(p, "Mode", Cmb(210, "off", "balanced", "strict"), "bandwidth.mode", "text", "off");
            Group(p, "Overrides");
            Row(p, "Ads and trackers", Tri(), "bandwidth.blockAds", "tri");
            Row(p, "Video and audio", Tri(), "bandwidth.blockMedia", "tri");
            Row(p, "Autoplay", Tri(), "bandwidth.blockAutoplay", "tri");
            Row(p, "Images", Tri(), "bandwidth.blockImages", "tri");
            Row(p, "Web fonts", Tri(), "bandwidth.blockFonts", "tri");
            Row(p, "Save-Data header", Tri(), "bandwidth.saveDataHeader", "tri");
            Note(p, "\"follow mode\" takes whatever the chosen mode implies.");
            Group(p, "Captchas");
            Row(p, null, Chk("Never save bandwidth inside a captcha or bot check"),
                "bandwidth.allowChallenges", "bool", true);
            Note(p, "hCaptcha, reCAPTCHA, Turnstile, Arkose, GeeTest, DataDome and the rest keep\n"
                  + "their images, fonts and audio challenge. Without this, strict mode leaves you\n"
                  + "a puzzle grid of empty boxes and no way past the page.");
            Group(p, "Extras");
            Row(p, "Extra block patterns", Area(430, 64), "bandwidth.extraBlockPatterns", "lines");
            Note(p, "One per line, e.g.   *.gif*    *cdn.example.com*");
            Row(p, "Cache size (MB)", Num(0, 4096), "bandwidth.diskCacheMB", "int", 256);
            Row(p, null, Chk("Report how much was downloaded when the session ends"), "bandwidth.report", "bool", true);
            End();
        }

        private void BuildStatusPage(ScrollHost h)
        {
            var p = Begin(h);
            Head(p, "Status tab", "A local summary as the first tab: the identity in use, what websites\nactually see, and the current public IP.");
            Row(p, null, Chk("Open the status tab first"), "statusPage.enabled", "bool", false);
            Row(p, null, Chk("Look up the public IP on that page"), "statusPage.checkIp", "bool", true);
            Note(p, "The lookup runs from inside the browser, so it reflects the interface and\nproxy this session is actually using. Turn it off for no outbound request.");
            Row(p, "IP service", Txt(430), "statusPage.ipService", "text", "https://ipinfo.io/json");
            Row(p, "Fallback", Txt(430), "statusPage.ipFallback", "text", "https://api.ipify.org?format=json");

            Group(p, "IP quality");
            Row(p, null, Chk("Score how a website is likely to judge this address"),
                "statusPage.checkQuality", "bool", true);
            Note(p, "Starts at 100 and subtracts what the lookup reports: a datacenter range or a\n"
                  + "flagged proxy costs the most, a mobile CGNAT address a little, and a browser\n"
                  + "timezone that disagrees with the IP's costs too. Every deduction is listed with\n"
                  + "its weight, so the number can be checked rather than trusted.");
            Row(p, "Quality service", Txt(430), "statusPage.qualityService", "text",
                "http://ip-api.com/json/?fields=status,message,country,countryCode,city,timezone,isp,org,as,reverse,mobile,proxy,hosting,query");
            Note(p, "Free and keyless. Plain HTTP because that is what the free tier serves - the\n"
                  + "status page is local HTTP too, so nothing is downgraded. Any service reporting\n"
                  + "proxy / hosting / mobile under the same names works here.");
            End();
        }

        private void BuildRecording(ScrollHost h)
        {
            var p = Begin(h);
            Head(p, "Session recording", "Records clicks, typing, dropdowns, forms, keys, scrolling and navigation\ninto a readable .log, a structured .jsonl, and a browsable HTML timeline.");
            Row(p, null, Chk("Record the session"), "debug.enabled", "bool", false);
            Row(p, "Detail level", Cmb(170, "error", "warn", "info", "debug"), "debug.level", "text", "info");
            Row(p, null, Chk("Mirror log lines into the output pane below"), "debug.console", "bool", true);
            Group(p, "What to capture");
            Row(p, null, Chk("Interactions (clicks, typing, forms)"), "debug.interactions", "bool", true);
            Row(p, null, Chk("Page console output"), "debug.captureConsole", "bool", true);
            Row(p, null, Chk("Network requests and responses"), "debug.network", "bool", true);
            Row(p, null, Chk("Browser warnings (CSP, mixed content)"), "debug.browserLogs", "bool", true);
            Row(p, null, Chk("Named keys and shortcuts"), "debug.captureKeys", "bool", true);
            Row(p, null, Chk("Scroll depth milestones"), "debug.captureScroll", "bool", true);
            Group(p, "Field values");
            Row(p, null, Chk("Record what was typed into each field"), "debug.captureValues", "bool", true);
            Row(p, null, Chk("Keep password and credential fields masked"), "debug.redactSecrets", "bool", true);
            Note(p, "Unchecking the mask writes real passwords into a plain text file on disk.\nOnly do that deliberately.", true);
            Row(p, "Max value length", Num(20, 4000), "debug.maxValueLength", "int", 200);
            Row(p, "Typing pause (ms)", Num(100, 5000), "debug.typeIdleMs", "int", 900, "one entry per field");
            Group(p, "Output");
            Row(p, null, Chk("Write the .jsonl structured sidecar"), "debug.jsonl", "bool", true);
            Row(p, null, Chk("Write the HTML timeline"), "debug.htmlReport", "bool", true);
            Row(p, "Log folder", Txt(430), "debug.logDir", "text", "logs");
            End();
        }

        private void BuildMacro(ScrollHost h)
        {
            var p = Begin(h);
            Head(p, "Macro replay", "Point this at a recording and the session performs it again: same clicks,\nsame text in the same fields, same submits, in the same order.");
            var file = Txt(348);
            Row(p, "Macro file", file, "macro.file", "textOrNull", "");
            var browse = new FlatButton("Browse...", 88) { Location = new Point(206 + 358, file.Top - 4), Height = 28 };
            browse.Click += (s, e) =>
            {
                using (var dlg = new OpenFileDialog())
                {
                    dlg.Title = "Choose a recording or a saved macro";
                    dlg.Filter = "Recordings and macros (*.jsonl;*.json)|*.jsonl;*.json|All files (*.*)|*.*";
                    var start = Path.Combine(_root, "logs");
                    dlg.InitialDirectory = Directory.Exists(start) ? start : _root;
                    if (dlg.ShowDialog(this) == DialogResult.OK) file.Text = dlg.FileName;
                }
            };
            p.Controls.Add(browse);
            Note(p, "Any .jsonl from a recorded session works directly. Leave empty to not replay.");
            Row(p, "Speed", Num(0, 10, 1), "macro.speed", "dec", 1, "1 = as recorded");
            Row(p, "Max wait between steps", Num(0, 60000), "macro.maxDelayMs", "int", 3000);
            Row(p, "Wait for element (ms)", Num(500, 120000), "macro.waitForMs", "int", 10000);
            Row(p, null, Chk("Stop at the first step that cannot be performed"), "macro.stopOnMissing", "bool", false);
            Note(p, "Fields the recording masked cannot be replayed. Supply them under\n\"macro\": { \"secrets\": { \"#password\": \"...\" } } in config.json.");
            End();
        }

        private void BuildPrivacy(ScrollHost h)
        {
            var p = Begin(h);
            Head(p, "Privacy", "Every launch uses a throwaway profile and deletes it on exit: cookies,\ncache, history, localStorage and service workers all go with it.");
            Row(p, null, Chk("Delete the profile when the browser closes"), "privacy.wipeOnExit", "bool", true);
            Row(p, "Profile folder", Txt(430), "privacy.profileRoot", "textOrNull", "");
            Note(p, "Empty = the OS temp folder.");
            Group(p, "Browser behaviour");
            Row(p, null, Chk("Block third-party cookies"), "privacy.blockThirdPartyCookies", "bool", true);
            Row(p, null, Chk("Send Do Not Track"), "privacy.doNotTrack", "bool", true);
            Row(p, null, Chk("Disable sync and sign-in"), "privacy.disableSync", "bool", true);
            Row(p, null, Chk("Disable background networking"), "privacy.disableBackgroundNetworking", "bool", true);
            Row(p, null, Chk("Disable the Privacy Sandbox APIs"), "privacy.disablePrivacySandbox", "bool", true);
            Row(p, null, Chk("Block geolocation requests"), "privacy.blockGeolocation", "bool", true);
            Row(p, null, Chk("Block motion and light sensors"), "privacy.blockSensors", "bool", true);
            Row(p, null, Chk("Enable Safe Browsing (sends URL hashes to Google)"), "privacy.safeBrowsing", "bool", false);
            End();
        }

        private void BuildAdvanced(ScrollHost h)
        {
            var p = Begin(h);
            Head(p, "Advanced", "Extras that are passed straight through to the browser.");
            Row(p, "Extensions", Area(430, 64), "extensions", "lines");
            Note(p, "One unpacked extension folder per line (not .crx files).");
            Row(p, "Chromium flags", Txt(430), "flags", "csv");
            Note(p, "Comma separated, e.g.  --force-dark-mode, --mute-audio");
            Row(p, null, Chk("Verbose launcher internals (proxy, CDP, cleanup)"), "verbose", "bool", false);
            Group(p, "Config file");
            Note(p, "Saving writes plain JSON, so the explanatory comments are dropped.\nThe documented copy lives in config.example.json; the previous file is\nalways kept as config.json.bak.");
            var restore = new FlatButton("Restore documented config", 210) { Location = new Point(23, _y) };
            restore.Click += (s, e) => { RunTool("--init-config"); LoadConfig(); };
            p.Controls.Add(restore);
            _y += 40;
            End();
        }

        private class Adapter
        {
            public string Name = "", Description = "", Address = "", Kind = "other";
        }

        /// <summary>Active adapters, with the detail needed to tell two apart.</summary>
        private static List<Adapter> ListAdapters()
        {
            var found = new List<Adapter>();
            try
            {
                foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up) continue;
                    if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;

                    var ip = "";
                    foreach (var a in ni.GetIPProperties().UnicastAddresses)
                        if (a.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                        { ip = a.Address.ToString(); break; }
                    if (ip.Length == 0) continue;

                    var hay = (ni.Name + " " + ni.Description).ToLowerInvariant();
                    string kind;
                    // Same classification the launcher uses, so the aliases offered
                    // here are the ones that will actually resolve.
                    if (System.Text.RegularExpressions.Regex.IsMatch(hay, "vpn|nordlynx|wireguard|wg[0-9]|tun[0-9]|tap[0-9]|openvpn|proton|mullvad|tailscale|zerotier")) kind = "vpn";
                    else if (System.Text.RegularExpressions.Regex.IsMatch(hay, "vethernet|virtualbox|vmware|hyper-v|docker|loopback|bluetooth|default switch|wsl")) kind = "virtual";
                    else if (ni.NetworkInterfaceType == NetworkInterfaceType.Wireless80211
                             || System.Text.RegularExpressions.Regex.IsMatch(hay, "wi[ -]?fi|wireless|wlan")) kind = "wifi";
                    else if (System.Text.RegularExpressions.Regex.IsMatch(hay, "ethernet|eth[0-9]|lan")) kind = "ethernet";
                    else kind = "other";

                    found.Add(new Adapter { Name = ni.Name, Description = ni.Description, Address = ip, Kind = kind });
                }
            }
            catch { }
            return found;
        }

        /// <summary>
        /// Everything you might reasonably pick, spelled out: the default route,
        /// the aliases that resolve on this machine (numbered where there is
        /// more than one of a kind), and every adapter by its exact name.
        /// </summary>
        private static List<ComboItem> InterfaceChoices()
        {
            var items = new List<ComboItem> { new ComboItem("auto", "auto  -  follow the OS default route") };
            var adapters = ListAdapters();

            foreach (var alias in new[] { "wifi", "lan", "vpn" })
            {
                var kind = alias == "lan" ? "ethernet" : alias;
                var of = adapters.FindAll(a => a.Kind == kind);
                for (int i = 0; i < of.Count; i++)
                {
                    // A single adapter of a kind keeps the plain alias; several
                    // get numbered, because a bare alias would be ambiguous.
                    var value = of.Count == 1 ? alias : alias + (i + 1);
                    items.Add(new ComboItem(value, value + "  -  " + of[i].Name + "  (" + of[i].Address + ")"));
                }
            }

            foreach (var a in adapters)
            {
                var detail = a.Description.Length > 0 ? a.Description : a.Kind;
                items.Add(new ComboItem(a.Name, a.Name + "  -  " + detail + "  (" + a.Address + ")"));
            }
            return items;
        }

        // ------------------------------------------------------ config wiring

        private void LoadConfig()
        {
            string json, err;
            if (!RunCapture("--dump-config", out json, out err))
            {
                Info("Could not read the config: " + (err.Length > 0 ? err.Trim() : "node did not run"));
                return;
            }
            try { _cfg.Load(json); }
            catch (Exception ex) { Info("Config could not be parsed: " + ex.Message); return; }

            foreach (var f in _fields)
            {
                try { Apply(f); }
                catch (Exception ex) { Info("Could not load " + f.Path + ": " + ex.Message); }
            }

            Info(_cfg.SourceFile.Length > 0
                ? "Config: " + _cfg.SourceFile
                : "No config file found - running on defaults.");
        }

        /// <summary>
        /// Every fingerprint override, plus the two settings that decide whether
        /// anything is injected into the page at all.
        /// </summary>
        private static readonly string[] SpoofPaths = {
            "identity.spoof.userAgent", "identity.spoof.locale", "identity.spoof.timezone",
            "identity.spoof.geolocation", "identity.spoof.screen", "identity.spoof.hardware",
            "identity.spoof.webgl", "identity.spoof.webglNoise", "identity.spoof.canvasNoise",
            "identity.spoof.audioNoise",
        };

        /// <summary>
        /// Flip the whole spoofing surface in one go.
        ///
        /// "No spoof" is not just the checkboxes: the recorder injects a script
        /// into every document and DevTools turns the Runtime domain on for it,
        /// which is exactly what a bot check looks for. Leaving those on would
        /// make the preset a half-measure, so they go too.
        /// </summary>
        private void ApplyPreset(bool stealth)
        {
            SetBool("identity.randomize", stealth);
            foreach (var path in SpoofPaths) SetBool(path, stealth);
            // These two keep their documented defaults either way: metric noise
            // breaks layouts, and the Client Hints fallback is off by default.
            SetBool("identity.spoof.fontNoise", false);
            _cfg.Set("identity.spoof.uaDataFallback", false);

            // Recording is not a stealth setting, so the preset borrows it
            // rather than deciding it: whatever it was before "No spoof" is what
            // comes back. Nothing is forced on for someone who never wanted it.
            if (stealth)
            {
                if (_debugBeforePreset.HasValue) SetBool("debug.enabled", _debugBeforePreset.Value);
                _debugBeforePreset = null;
            }
            else
            {
                if (!_debugBeforePreset.HasValue) _debugBeforePreset = GetBool("debug.enabled");
                SetBool("debug.enabled", false);
            }

            Info(stealth
                ? "Full stealth: every override back on."
                : "No spoof: overrides and recording off. Disposable profile and network binding stay.");
        }

        /// <summary>Recording state from before "No spoof" turned it off.</summary>
        private bool? _debugBeforePreset;

        private bool GetBool(string path)
        {
            foreach (var f in _fields)
            {
                var chk = f.Ctl as CheckBox;
                if (f.Path == path && chk != null) return chk.Checked;
            }
            return false;
        }

        /// <summary>Set one checkbox by config path, if the page has one.</summary>
        private void SetBool(string path, bool value)
        {
            foreach (var f in _fields)
            {
                var chk = f.Ctl as CheckBox;
                if (f.Path == path && f.Kind == "bool" && chk != null) { chk.Checked = value; return; }
            }
        }

        private void Apply(Field f)
        {
            switch (f.Kind)
            {
                case "bool":
                    ((CheckBox)f.Ctl).Checked = _cfg.GetBool(f.Path, (bool)(f.Fallback ?? false));
                    break;
                case "text":
                case "textOrNull":
                    {
                        var v = _cfg.GetString(f.Path, Convert.ToString(f.Fallback ?? ""));
                        var cb = f.Ctl as ComboBox;
                        if (cb != null) SelectValue(cb, v);
                        else f.Ctl.Text = v;
                        break;
                    }
                case "int":
                    SetNum((NumericUpDown)f.Ctl, _cfg.GetInt(f.Path, Convert.ToInt32(f.Fallback ?? 0)));
                    break;
                case "intOrNull":
                    SetNum((NumericUpDown)f.Ctl, _cfg.Raw(f.Path) == null ? 0 : _cfg.GetInt(f.Path, 0));
                    break;
                case "dec":
                    SetNum((NumericUpDown)f.Ctl, _cfg.GetDecimal(f.Path, Convert.ToDecimal(f.Fallback ?? 1)));
                    break;
                case "lines":
                    ((TextBox)f.Ctl).Lines = _cfg.GetList(f.Path).ToArray();
                    break;
                case "csv":
                    f.Ctl.Text = string.Join(", ", _cfg.GetList(f.Path));
                    break;
                case "tri":
                    {
                        var raw = _cfg.Raw(f.Path);
                        ((ComboBox)f.Ctl).SelectedIndex = raw == null ? 0 : (Convert.ToBoolean(raw) ? 1 : 2);
                        break;
                    }
            }
        }

        /// <summary>
        /// Select by the value a row stands for, not by its label. A value the
        /// list does not offer - a source IP, a browser path - is added rather
        /// than silently dropped.
        /// </summary>
        private static void SelectValue(ComboBox cb, string value)
        {
            for (int i = 0; i < cb.Items.Count; i++)
            {
                var ci = cb.Items[i] as ComboItem;
                var candidate = ci != null ? ci.Value : cb.Items[i].ToString();
                if (string.Equals(candidate, value, StringComparison.OrdinalIgnoreCase))
                {
                    cb.SelectedIndex = i;
                    return;
                }
            }
            if (value.Length > 0)
            {
                cb.Items.Insert(0, new ComboItem(value, value));
                cb.SelectedIndex = 0;
            }
            else if (cb.Items.Count > 0) cb.SelectedIndex = 0;
        }

        /// <summary>The value behind a control, unwrapping labelled entries.</summary>
        private static string ValueOf(Control c)
        {
            var cb = c as ComboBox;
            if (cb != null)
            {
                var ci = cb.SelectedItem as ComboItem;
                if (ci != null) return ci.Value;
                if (cb.SelectedItem != null) return cb.SelectedItem.ToString().Trim();
            }
            return c.Text.Trim();
        }

        private static void SetNum(NumericUpDown n, decimal v)
        {
            n.Value = v < n.Minimum ? n.Minimum : (v > n.Maximum ? n.Maximum : v);
        }

        private bool SaveConfig()
        {
            CollectActive();
            // Which view was in use is a property of this app, not of a session,
            // but it lives in the same file so there is only ever one to move.
            _cfg.Set("gui.mode", _mode);

            var target = Path.Combine(_root, "config.json");
            try
            {
                if (File.Exists(target)) File.Copy(target, target + ".bak", true);
                File.WriteAllText(target, _cfg.ToPrettyJson() + Environment.NewLine, new UTF8Encoding(false));
                return true;
            }
            catch (Exception ex)
            {
                Info("Could not write config.json: " + ex.Message);
                return false;
            }
        }

        /// <summary>Read back only the view the user can actually see.</summary>
        private void CollectActive()
        {
            foreach (var f in _fields)
            {
                if (f.Mode != null && f.Mode != _mode) continue;
                // One awkward field must not throw an unhandled exception dialog
                // in the user's face and lose the rest of their settings with it.
                try { Collect(f); }
                catch (Exception ex) { Info("Could not read " + f.Path + ": " + ex.Message); }
            }
        }

        private void Collect(Field f)
        {
            switch (f.Kind)
            {
                case "bool": _cfg.Set(f.Path, ((CheckBox)f.Ctl).Checked); break;
                case "text": _cfg.Set(f.Path, ValueOf(f.Ctl)); break;
                case "textOrNull":
                    {
                        var t = ValueOf(f.Ctl);
                        _cfg.Set(f.Path, t.Length == 0 ? null : (object)t);
                        break;
                    }
                case "int": _cfg.Set(f.Path, (int)((NumericUpDown)f.Ctl).Value); break;
                case "intOrNull":
                    {
                        var v = (int)((NumericUpDown)f.Ctl).Value;
                        _cfg.Set(f.Path, v == 0 ? null : (object)v);
                        break;
                    }
                case "dec": _cfg.Set(f.Path, (double)((NumericUpDown)f.Ctl).Value); break;
                case "lines":
                    _cfg.Set(f.Path, ((TextBox)f.Ctl).Lines
                        .Select(l => l.Trim()).Where(l => l.Length > 0).ToList());
                    break;
                case "csv":
                    _cfg.Set(f.Path, f.Ctl.Text
                        .Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries)
                        .Select(l => l.Trim()).Where(l => l.Length > 0).ToList());
                    break;
                case "tri":
                    {
                        var i = ((ComboBox)f.Ctl).SelectedIndex;
                        _cfg.Set(f.Path, i <= 0 ? null : (object)(i == 1));
                        break;
                    }
            }
        }

        // ----------------------------------------------------------- running

        private string NodePath()
        {
            var pf = Environment.GetEnvironmentVariable("ProgramFiles");
            if (!string.IsNullOrEmpty(pf))
            {
                var p = Path.Combine(pf, "nodejs", "node.exe");
                if (File.Exists(p)) return p;
            }
            return "node.exe";
        }

        private ProcessStartInfo NodeStart(string args)
        {
            return new ProcessStartInfo
            {
                FileName = NodePath(),
                Arguments = "\"" + Path.Combine(_root, "src", "index.js") + "\" " + args,
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
        }

        private bool RunCapture(string args, out string stdout, out string stderr)
        {
            stdout = ""; stderr = "";
            try
            {
                using (var p = Process.Start(NodeStart(args)))
                {
                    stdout = p.StandardOutput.ReadToEnd();
                    stderr = p.StandardError.ReadToEnd();
                    p.WaitForExit(25000);
                    return stdout.Length > 0;
                }
            }
            catch (Exception ex)
            {
                stderr = ex.Message + " - is Node.js installed and on PATH?";
                return false;
            }
        }

        /// <summary>
        /// Run a launcher command with its output streamed in, for anything too
        /// slow to block the UI thread on - a browser download, for instance.
        /// </summary>
        private void RunStreaming(string args, string busy)
        {
            Process p;
            try { p = Process.Start(NodeStart(args)); }
            catch (Exception ex) { Info("Could not start Node: " + ex.Message); return; }

            ToggleLog(true);
            Info(busy);
            _console.Append("> " + args + Environment.NewLine);

            p.EnableRaisingEvents = true;
            _runErrors.Clear();
            p.OutputDataReceived += (s, e) => Append(e.Data);
            p.ErrorDataReceived += (s, e) => Append(e.Data, true);
            p.Exited += (s, e) =>
            {
                try
                {
                    BeginInvoke((Action)(() =>
                    {
                        Info(p.ExitCode == 0 ? "Done." : "Finished with errors.");
                        LoadConfig();
                        ReportErrors("Browser download", p.ExitCode);
                    }));
                }
                catch { }
            };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
        }

        private void RunTool(string args)
        {
            _console.Append("Session", "> " + args + Environment.NewLine);
            string so, se;
            RunCapture(args, out so, out se);
            if (so.Length > 0) _console.Append("Session", so.TrimEnd() + Environment.NewLine);
            if (se.Length > 0) _console.Append("Session", se.TrimEnd() + Environment.NewLine);
            _console.Append("Session", Environment.NewLine);

            // A [FAIL] row from --check is a real problem even though the tool
            // exits cleanly, so treat it the same as anything on stderr.
            _runErrors.Clear();
            foreach (var line in (so + Environment.NewLine + se).Split(LineBreaks, StringSplitOptions.RemoveEmptyEntries))
            {
                var t = line.Trim();
                if (t.StartsWith("[FAIL]") || t.StartsWith("Error:")) _runErrors.Add(t);
            }
            if (_runErrors.Count > 0) ReportErrors("Setup check", 0);
        }

        private void Launch()
        {
            if (!SaveConfig()) return;
            _runErrors.Clear();

            // A fresh run starts with a clean set of tabs; a run started while
            // another is still going gets its own prefix instead of merging.
            if (_running.Count == 0) { _console.Clear(); _runSeq = 1; } else _runSeq++;
            var runLabel = _runSeq > 1 ? "R" + _runSeq + " " : "";

            Process p;
            try { p = Process.Start(NodeStart("")); }
            catch (Exception ex)
            {
                Info("Could not start Node: " + ex.Message);
                MessageBox.Show(this,
                    "Node.js is required and was not found.\r\n\r\nInstall it from nodejs.org, then launch again.",
                    "Node.js not found", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            p.EnableRaisingEvents = true;
            p.OutputDataReceived += (s, e) => Append(e.Data, false, runLabel);
            p.ErrorDataReceived += (s, e) => Append(e.Data, true, runLabel);
            p.Exited += (s, e) =>
            {
                try
                {
                    BeginInvoke((Action)(() =>
                    {
                        _running.Remove(p);
                        if (_running.Count == 0) { _stop.Enabled = false; Info("Session ended."); }
                        ReportErrors("Session", p.ExitCode);
                    }));
                }
                catch { }
            };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();

            _running.Add(p);
            _stop.Enabled = true;
            // A session is exactly when the output becomes worth seeing.
            ToggleLog(true);
            Info("Session running. Closing every browser window ends it and wipes the profile.");
        }

        /// <summary>
        /// Multi-instance runs tag their output with #1, #2 and so on. Route by
        /// that tag so each browser gets its own view instead of three sessions
        /// interleaving into one unreadable stream.
        /// </summary>
        // The tag sits either at the start of a status line ("#2 launching...")
        // or right after a log line's timestamp and offset. Matching only those
        // two shapes keeps a "#333" inside a message from inventing a channel.
        private static readonly System.Text.RegularExpressions.Regex InstanceTag =
            new System.Text.RegularExpressions.Regex(@"^(?:\[[^\]]*\]\s*\+\s*[\d.]+s\s+)?#(\d+)(?:\s|$)");

        private void Append(string line, bool isError = false) { Append(line, isError, ""); }

        /// <summary>
        /// Route one output line to its own channel. <paramref name="runLabel"/>
        /// separates a second launch started while the first is still running;
        /// it is empty for the usual single run.
        /// </summary>
        private void Append(string line, bool isError, string runLabel)
        {
            if (line == null || IsDisposed || !IsHandleCreated) return;
            var m = InstanceTag.Match(line);
            var channel = runLabel + (m.Success ? "#" + m.Groups[1].Value : "Session");
            if (isError) _runErrors.Add(line.Trim());
            try { BeginInvoke((Action)(() => _console.Append(channel, line + Environment.NewLine))); }
            catch { }
        }

        private void StopAll()
        {
            foreach (var p in _running.ToList())
            {
                try
                {
                    if (!p.HasExited)
                    {
                        // Kill the tree: node spawns the browser as a child.
                        Process.Start(new ProcessStartInfo("taskkill", "/PID " + p.Id + " /T /F")
                        { CreateNoWindow = true, UseShellExecute = false });
                    }
                }
                catch { }
            }
            _running.Clear();
            _stop.Enabled = false;
        }

        private void OpenFolder(string name)
        {
            var dir = Path.Combine(_root, name);
            try
            {
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                Process.Start("explorer.exe", "\"" + dir + "\"");
            }
            catch (Exception ex) { Info("Could not open " + dir + ": " + ex.Message); }
        }

        /// <summary>
        /// Show or hide the output pane by growing and shrinking the window,
        /// so a hidden log takes up no room whatsoever.
        /// </summary>
        private void ToggleLog(bool open, bool animate = true)
        {
            // Settle any half-finished toggle before reading Height and Top, so
            // the new animation starts from a state that actually exists.
            _logSlide.FinishPending();

            // Asking for the state it is already in is a no-op, not a second
            // animation. Launch requests "open" every time, and without this a
            // launch while the log is already up would grow the window again.
            if (open == _logOpen && !_resizingLog)
            {
                if (_logToggle != null) _logToggle.Text = open ? "Hide log" : "Show log";
                _split.Panel2Collapsed = !open;
                return;
            }

            if (_logToggle != null) _logToggle.Text = open ? "Hide log" : "Show log";
            _logOpen = open;
            _resizingLog = true;

            if (open)
            {
                _split.Panel2Collapsed = false;
                // Keep the settings pane exactly as tall as it is now.
                try { _split.SplitterDistance = Math.Max(_split.Panel1MinSize, _split.Height - _split.SplitterWidth); }
                catch { }
            }

            // Grow inside the working area, which excludes the taskbar.
            var work = Screen.FromControl(this).WorkingArea;
            _logFrom = Height;
            _topFrom = Top;

            if (open)
            {
                _logTo = Math.Min(_baseHeight + LogPaneHeight, work.Height);
                if (Top + _logTo > work.Bottom)
                {
                    // Not enough room below: slide the window up to make it.
                    _topBeforeGrow = Top;
                    _topTo = Math.Max(work.Top, work.Bottom - _logTo);
                    _topAfterGrow = _topTo;
                    _shiftedUp = true;
                }
                else
                {
                    _topTo = Top;
                    _shiftedUp = false;
                }
            }
            else
            {
                _logTo = _baseHeight;
                // Put it back where it was, unless the window has been moved
                // since, in which case leave it where the user put it.
                _topTo = (_shiftedUp && Top == _topAfterGrow) ? _topBeforeGrow : Top;
                _shiftedUp = false;
            }

            Action settle = () =>
            {
                if (!open) _split.Panel2Collapsed = true;
                _resizingLog = false;
            };

            if (!animate)
            {
                SetBounds(Left, _topTo, Width, _logTo);
                settle();
                return;
            }
            _logSlide.Set(0);
            _logSlide.To(1, 230, settle);
        }

        /// <summary>
        /// Raise whatever went wrong in a dialog. Called when a run ends, so a
        /// problem is never left sitting silently in a pane that may be hidden.
        /// </summary>
        private void ReportErrors(string what, int exitCode)
        {
            var lines = _runErrors
                .Where((l) => l.Length > 0)
                .Distinct()
                .Take(14)
                .ToList();
            _runErrors.Clear();

            if (lines.Count == 0 && exitCode == 0) return;

            var body = lines.Count > 0
                ? string.Join(Environment.NewLine, lines)
                : what + " exited with code " + exitCode + ".";
            if (lines.Count > 0 && exitCode != 0)
                body += Environment.NewLine + Environment.NewLine + "(exit code " + exitCode + ")";

            Info(lines.Count > 0 ? lines[0] : what + " failed.");
            MessageBox.Show(this, body, what + " reported a problem",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        private void Info(string text) { if (_status != null) _status.Text = text; }
    }
}
