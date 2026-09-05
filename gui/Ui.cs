// Custom dark-mode widgets for the StealthBrowser GUI.
//
// WinForms has no dark theme and no animation, and its scrollbars cannot be
// restyled - so the pieces that would look out of place are drawn here instead
// of using the stock controls. Everything is owner-drawn on top of plain
// Controls, which keeps it inside what csc.exe alone can build.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace StealthBrowser
{
    internal static class Theme
    {
        public static readonly Color Bg = Color.FromArgb(17, 19, 24);
        public static readonly Color Panel = Color.FromArgb(23, 26, 32);
        public static readonly Color Raised = Color.FromArgb(30, 34, 42);
        public static readonly Color Nav = Color.FromArgb(20, 22, 28);
        public static readonly Color Input = Color.FromArgb(35, 39, 48);
        public static readonly Color Line = Color.FromArgb(45, 50, 60);
        public static readonly Color Text = Color.FromArgb(228, 232, 238);
        public static readonly Color Dim = Color.FromArgb(140, 148, 162);
        public static readonly Color Faint = Color.FromArgb(98, 105, 118);
        public static readonly Color Accent = Color.FromArgb(88, 140, 255);
        public static readonly Color AccentDim = Color.FromArgb(52, 84, 160);
        public static readonly Color Warn = Color.FromArgb(240, 178, 92);
        public static readonly Color Ok = Color.FromArgb(96, 210, 140);
        public static readonly Color ConsoleBg = Color.FromArgb(13, 15, 19);
        public static readonly Color ConsoleFg = Color.FromArgb(198, 206, 218);

        /// <summary>Pick the first installed face, so nicer fonts are used where present.</summary>
        public static Font Pick(float size, FontStyle style, params string[] names)
        {
            using (var installed = new InstalledFontCollection())
            {
                var have = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var f in installed.Families) have.Add(f.Name);
                foreach (var n in names)
                    if (have.Contains(n)) return new Font(n, size, style);
            }
            return new Font(SystemFonts.MessageBoxFont.FontFamily, size, style);
        }

        public static Font UI(float size = 9.5f, FontStyle style = FontStyle.Regular)
        {
            return Pick(size, style, "Segoe UI Variable Text", "Selawik", "Segoe UI");
        }

        public static Font Display(float size, FontStyle style = FontStyle.Bold)
        {
            return Pick(size, style, "Segoe UI Variable Display", "Segoe UI Semibold", "Segoe UI");
        }

        public static Font Mono(float size = 9f, FontStyle style = FontStyle.Regular)
        {
            return Pick(size, style, "Cascadia Mono", "Cascadia Code", "JetBrains Mono", "Consolas");
        }

        public static GraphicsPath Rounded(Rectangle r, int radius)
        {
            var p = new GraphicsPath();
            if (radius <= 0) { p.AddRectangle(r); return p; }
            int d = radius * 2;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static Color Mix(Color a, Color b, double t)
        {
            t = t < 0 ? 0 : (t > 1 ? 1 : t);
            return Color.FromArgb(
                (int)(a.R + (b.R - a.R) * t),
                (int)(a.G + (b.G - a.G) * t),
                (int)(a.B + (b.B - a.B) * t));
        }

        /// <summary>Ease-out cubic: quick to start, gentle to settle.</summary>
        public static double Ease(double t)
        {
            t = t < 0 ? 0 : (t > 1 ? 1 : t);
            var u = 1 - t;
            return 1 - u * u * u;
        }
    }

    internal static class Native
    {
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        public const int EM_LINESCROLL = 0xB6;
        public const int EM_GETLINECOUNT = 0xBA;
        public const int EM_GETFIRSTVISIBLELINE = 0xCE;

        /// <summary>Paint the title bar dark too, so the frame matches the app.</summary>
        public static void UseDarkTitleBar(IntPtr hwnd)
        {
            int on = 1;
            // 20 on current Windows builds, 19 on the first ones that supported it.
            if (DwmSetWindowAttribute(hwnd, 20, ref on, sizeof(int)) != 0)
                DwmSetWindowAttribute(hwnd, 19, ref on, sizeof(int));
        }
    }

    /// <summary>Drives a 0..1 value over a duration, for hover and slide effects.</summary>
    internal class Animator
    {
        private readonly Timer _timer = new Timer { Interval = 15 };
        private DateTime _start;
        private double _from, _to;
        private int _durationMs;
        private readonly Action<double> _apply;
        private Action _done;

        public double Value { get; private set; }

        public Animator(Action<double> apply)
        {
            _apply = apply;
            _timer.Tick += (s, e) =>
            {
                var elapsed = (DateTime.UtcNow - _start).TotalMilliseconds;
                var t = _durationMs <= 0 ? 1 : elapsed / _durationMs;
                if (t >= 1)
                {
                    t = 1;
                    _timer.Stop();
                }
                Value = _from + (_to - _from) * Theme.Ease(t);
                _apply(Value);
                if (t >= 1 && _done != null) { var d = _done; _done = null; d(); }
            };
        }

        public void To(double target, int ms, Action done = null)
        {
            // A superseded animation still has to settle its state, or whatever
            // the callback was going to fix stays half-done - which is how a
            // toggle ends up disagreeing with what it is toggling.
            FinishPending();
            _from = Value;
            _to = target;
            _durationMs = ms;
            _done = done;
            _start = DateTime.UtcNow;
            _timer.Stop();
            _timer.Start();
        }

        public void Set(double v)
        {
            FinishPending();
            _timer.Stop();
            Value = v;
            _apply(v);
        }

        /// <summary>Run and clear a pending completion callback, if any.</summary>
        public void FinishPending()
        {
            _timer.Stop();
            if (_done == null) return;
            var d = _done;
            _done = null;
            d();
        }
    }

    /// <summary>Flat button with a hover fade and an optional accent fill.</summary>
    internal class FlatButton : Control
    {
        private readonly Animator _hover;
        private bool _down;
        public bool Primary;

        public FlatButton(string text, int width, bool primary = false)
        {
            Text = text;
            Width = width;
            Height = 32;
            Primary = primary;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            TabStop = true;
            Font = Theme.UI(9.25f, primary ? FontStyle.Bold : FontStyle.Regular);
            Cursor = Cursors.Hand;
            _hover = new Animator(v => Invalidate());
        }

        // Keyboard activation: a control that only answers the mouse is one that
        // cannot be reached by Tab, which is worse than it sounds.
        protected override bool IsInputKey(Keys keyData)
        {
            if (keyData == Keys.Space || keyData == Keys.Enter) return true;
            return base.IsInputKey(keyData);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter)
            {
                _down = true;
                Invalidate();
            }
        }

        protected override void OnKeyUp(KeyEventArgs e)
        {
            base.OnKeyUp(e);
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter)
            {
                _down = false;
                Invalidate();
                OnClick(EventArgs.Empty);
            }
        }

        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); _hover.To(1, 120); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); _hover.To(0, 160); }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); _hover.To(1, 140); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); _down = false; _hover.To(0, 180); }
        protected override void OnMouseDown(MouseEventArgs e) { Focus(); base.OnMouseDown(e); _down = true; Invalidate(); }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); _down = false; Invalidate(); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            g.Clear(Parent != null ? Parent.BackColor : Theme.Panel);

            var r = new Rectangle(0, 0, Width - 1, Height - 1);
            Color fill, border, fg;
            if (Primary)
            {
                fill = Theme.Mix(Theme.Accent, Color.White, _hover.Value * 0.16);
                if (_down) fill = Theme.Mix(fill, Color.Black, 0.18);
                border = fill;
                fg = Color.White;
            }
            else
            {
                fill = Theme.Mix(Theme.Raised, Theme.Line, _hover.Value * 0.9);
                if (_down) fill = Theme.Mix(fill, Color.Black, 0.2);
                border = Theme.Mix(Theme.Line, Theme.Accent, _hover.Value * 0.5);
                fg = Enabled ? Theme.Text : Theme.Faint;
            }
            if (!Enabled) { fill = Theme.Raised; border = Theme.Line; fg = Theme.Faint; }

            using (var path = Theme.Rounded(r, 6))
            using (var b = new SolidBrush(fill))
            using (var p = new Pen(border))
            {
                g.FillPath(b, path);
                g.DrawPath(p, path);
            }
            TextRenderer.DrawText(g, Text, Font, r, fg,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }

        protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Invalidate(); }
    }

    /// <summary>Checkbox drawn to match the dark palette, with an animated tick.</summary>
    internal class DarkCheck : CheckBox
    {
        private readonly Animator _on;
        private readonly Animator _hover;

        public DarkCheck(string text)
        {
            Text = text;
            AutoSize = false;
            Height = 24;
            Width = 560;
            ForeColor = Theme.Text;
            BackColor = Color.Transparent;
            Font = Theme.UI();
            Cursor = Cursors.Hand;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor, true);
            _on = new Animator(v => Invalidate());
            _hover = new Animator(v => Invalidate());
            CheckedChanged += (s, e) => _on.To(Checked ? 1 : 0, 130);
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); _hover.To(1, 120); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); _hover.To(0, 160); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            using (var bg = new SolidBrush(Parent != null ? Parent.BackColor : Theme.Panel))
                g.FillRectangle(bg, ClientRectangle);

            var box = new Rectangle(1, (Height - 16) / 2, 16, 16);
            var fill = Theme.Mix(Theme.Input, Theme.Accent, _on.Value);
            var border = Theme.Mix(Theme.Mix(Theme.Line, Theme.Faint, _hover.Value), Theme.Accent, _on.Value);

            using (var path = Theme.Rounded(box, 4))
            using (var b = new SolidBrush(fill))
            using (var p = new Pen(border, 1.4f))
            {
                g.FillPath(b, path);
                g.DrawPath(p, path);
            }

            if (_on.Value > 0.05)
            {
                // Draw the tick progressively so it appears to be written on.
                using (var pen = new Pen(Color.FromArgb((int)(255 * Math.Min(1, _on.Value * 1.4)), 255, 255, 255), 1.9f))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    var a = new PointF(box.Left + 3.6f, box.Top + 8.2f);
                    var m = new PointF(box.Left + 6.6f, box.Top + 11.4f);
                    var c = new PointF(box.Left + 12.4f, box.Top + 4.8f);
                    var t = Math.Min(1, _on.Value * 1.6);
                    g.DrawLine(pen, a, new PointF(a.X + (m.X - a.X) * (float)Math.Min(1, t * 2), a.Y + (m.Y - a.Y) * (float)Math.Min(1, t * 2)));
                    if (t > 0.5)
                    {
                        var t2 = (float)((t - 0.5) * 2);
                        g.DrawLine(pen, m, new PointF(m.X + (c.X - m.X) * t2, m.Y + (c.Y - m.Y) * t2));
                    }
                }
            }

            var textRect = new Rectangle(box.Right + 10, 0, Width - box.Right - 12, Height);
            TextRenderer.DrawText(g, Text, Font, textRect, Enabled ? ForeColor : Theme.Faint,
                TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }
    }

    /// <summary>A thin, self-drawn scrollbar. Native ones cannot be themed.</summary>
    internal class ThinScroll : Control
    {
        private int _viewport = 1, _content = 1, _offset;
        private bool _dragging;
        private int _grabY;
        private readonly Animator _hover;

        public event Action<int> Scrolled;

        public ThinScroll()
        {
            Width = 10;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            _hover = new Animator(v => Invalidate());
        }

        public int Offset { get { return _offset; } }
        public int MaxOffset { get { return Math.Max(0, _content - _viewport); } }

        public void Configure(int viewport, int content, int offset)
        {
            _viewport = Math.Max(1, viewport);
            _content = Math.Max(1, content);
            _offset = Math.Max(0, Math.Min(MaxOffset, offset));
            Visible = _content > _viewport;
            Invalidate();
        }

        public void SetOffset(int offset)
        {
            var clamped = Math.Max(0, Math.Min(MaxOffset, offset));
            if (clamped == _offset) return;
            _offset = clamped;
            Invalidate();
            if (Scrolled != null) Scrolled(_offset);
        }

        private Rectangle Thumb()
        {
            if (MaxOffset <= 0) return Rectangle.Empty;
            int track = Height - 8;
            int h = Math.Max(28, (int)((double)_viewport / _content * track));
            int y = 4 + (int)((double)_offset / MaxOffset * (track - h));
            return new Rectangle(2, y, Width - 4, h);
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); _hover.To(1, 130); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); if (!_dragging) _hover.To(0, 200); }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            var t = Thumb();
            if (t.Contains(e.Location)) { _dragging = true; _grabY = e.Y - t.Y; }
            else if (MaxOffset > 0)
            {
                int track = Height - 8;
                var h = Thumb().Height;
                SetOffset((int)((double)(e.Y - h / 2 - 4) / Math.Max(1, track - h) * MaxOffset));
                _dragging = true;
                _grabY = Thumb().Height / 2;
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (!_dragging) return;
            int track = Height - 8;
            var h = Thumb().Height;
            SetOffset((int)((double)(e.Y - _grabY - 4) / Math.Max(1, track - h) * MaxOffset));
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            _dragging = false;
            if (!ClientRectangle.Contains(PointToClient(Cursor.Position))) _hover.To(0, 200);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var bg = new SolidBrush(Parent != null ? Parent.BackColor : Theme.Panel))
                g.FillRectangle(bg, ClientRectangle);

            var t = Thumb();
            if (t.IsEmpty) return;
            var c = Theme.Mix(Theme.Line, Theme.Faint, 0.35 + _hover.Value * 0.65);
            // The bar widens slightly on hover, the way modern scrollbars do.
            var grow = (int)Math.Round(_hover.Value * 2);
            var rect = new Rectangle(t.X - grow, t.Y, t.Width + grow * 2, t.Height);
            using (var path = Theme.Rounded(rect, rect.Width / 2))
            using (var b = new SolidBrush(c))
                g.FillPath(b, path);
        }
    }

    /// <summary>
    /// A scrollable region with no native scrollbar: content lives in an inner
    /// panel whose Top is moved, and a ThinScroll drives it.
    /// </summary>
    internal class ScrollHost : Panel
    {
        public Panel Content { get; private set; }
        private readonly ThinScroll _bar = new ThinScroll();
        private readonly Animator _glide;
        private int _target;

        public ScrollHost()
        {
            BackColor = Theme.Panel;
            Content = new Panel { BackColor = Theme.Panel, Location = new Point(0, 0) };
            Controls.Add(Content);
            _bar.Dock = DockStyle.Right;
            Controls.Add(_bar);
            _bar.Scrolled += (v) => { _target = v; Content.Top = -v; };
            _glide = new Animator(v =>
            {
                Content.Top = -(int)Math.Round(v);
                _bar.SetOffset((int)Math.Round(v));
            });
        }

        public void Recalculate(int contentHeight)
        {
            Content.Width = Width - _bar.Width - 2;
            Content.Height = contentHeight;
            _bar.Configure(Height, contentHeight, -Content.Top);
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            Content.Width = Width - _bar.Width - 2;
            _bar.Configure(Height, Content.Height, -Content.Top);
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e);
            Glide(-e.Delta / 120 * 64);
        }

        /// <summary>Wheel scrolling eases rather than jumping, which reads much better.</summary>
        public void Glide(int delta)
        {
            var max = Math.Max(0, Content.Height - Height);
            _target = Math.Max(0, Math.Min(max, _target + delta));
            _glide.To(_target, 190);
        }

        public void ResetScroll()
        {
            _target = 0;
            _glide.Set(0);
            _bar.SetOffset(0);
            Content.Top = 0;
        }
    }

    /// <summary>Sidebar with an accent bar that slides between entries.</summary>
    internal class NavPanel : Control
    {
        private readonly string[] _items;
        private int _index;
        private int _hoverIndex = -1;
        private readonly Animator _slide;
        private double _barY;

        public const int RowHeight = 34;
        public event Action<int> Selected;

        public NavPanel(string[] items)
        {
            _items = items;
            BackColor = Theme.Nav;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
            Font = Theme.UI(9.5f);
            _slide = new Animator(v => { _barY = v; Invalidate(); });
        }

        public int Index { get { return _index; } }

        public void Select(int i)
        {
            if (i < 0 || i >= _items.Length) return;
            SetIndex(i);
            if (Selected != null) Selected(i);
        }

        /// <summary>
        /// Move the highlight without announcing a selection, so any other route
        /// to a page keeps the indicator honest instead of leaving it behind.
        /// </summary>
        public void SetIndex(int i)
        {
            if (i < 0 || i >= _items.Length || i == _index) return;
            _index = i;
            _slide.To(i * RowHeight, 220);
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            var i = (e.Y - 8) / RowHeight;
            if (i < 0 || i >= _items.Length) i = -1;
            if (i != _hoverIndex) { _hoverIndex = i; Cursor = i >= 0 ? Cursors.Hand : Cursors.Default; Invalidate(); }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            _hoverIndex = -1;
            Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            var i = (e.Y - 8) / RowHeight;
            if (i >= 0 && i < _items.Length) Select(i);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            using (var bg = new SolidBrush(Theme.Nav)) g.FillRectangle(bg, ClientRectangle);

            // The moving highlight, drawn at the animated position rather than
            // at the selected row, so switching sections glides.
            var y = (int)Math.Round(_barY) + 8;
            var pill = new Rectangle(6, y + 2, Width - 12, RowHeight - 4);
            using (var path = Theme.Rounded(pill, 7))
            using (var b = new SolidBrush(Theme.Mix(Theme.Nav, Theme.Accent, 0.22)))
                g.FillPath(b, path);
            using (var b = new SolidBrush(Theme.Accent))
            using (var path = Theme.Rounded(new Rectangle(6, y + 8, 3, RowHeight - 16), 2))
                g.FillPath(b, path);

            for (int i = 0; i < _items.Length; i++)
            {
                var row = new Rectangle(0, 8 + i * RowHeight, Width, RowHeight);
                if (i == _hoverIndex && i != _index)
                {
                    using (var path = Theme.Rounded(new Rectangle(6, row.Y + 2, Width - 12, RowHeight - 4), 7))
                    using (var b = new SolidBrush(Theme.Mix(Theme.Nav, Color.White, 0.05)))
                        g.FillPath(b, path);
                }
                var selected = i == _index;
                var colour = selected ? Color.White : (i == _hoverIndex ? Theme.Text : Theme.Dim);
                using (var f = Theme.UI(9.5f, selected ? FontStyle.Bold : FontStyle.Regular))
                    TextRenderer.DrawText(g, _items[i], f,
                        new Rectangle(row.X + 20, row.Y, row.Width - 24, row.Height), colour,
                        TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            }
        }
    }

    /// <summary>
    /// Output pane: a dark TextBox with its native scrollbar replaced by a
    /// ThinScroll driven through EM_LINESCROLL.
    /// </summary>
    internal class ConsolePane : Panel
    {
        public TextBox Box { get; private set; }
        private readonly ThinScroll _bar = new ThinScroll();

        // One buffer per browser instance, so several running side by side do
        // not interleave into an unreadable single stream.
        private readonly Dictionary<string, StringBuilder> _buffers = new Dictionary<string, StringBuilder>();
        private readonly List<string> _order = new List<string>();
        private readonly FlowLayoutPanel _tabs;
        private string _active;

        private const int BufferCap = 400 * 1024;

        public ConsolePane()
        {
            BackColor = Theme.ConsoleBg;
            Padding = new Padding(10, 8, 0, 6);

            _tabs = new FlowLayoutPanel
            {
                Dock = DockStyle.Top, Height = 0, BackColor = Theme.ConsoleBg,
                Padding = new Padding(0, 2, 0, 4), WrapContents = false, AutoScroll = false,
            };

            Box = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.None,
                Dock = DockStyle.Fill,
                BackColor = Theme.ConsoleBg,
                ForeColor = Theme.ConsoleFg,
                Font = Theme.Mono(8.75f),
                WordWrap = false,
                BorderStyle = BorderStyle.None,
            };
            Controls.Add(Box);
            _bar.Dock = DockStyle.Right;
            _bar.BackColor = Theme.ConsoleBg;
            Controls.Add(_bar);
            Controls.Add(_tabs);

            _bar.Scrolled += (v) =>
            {
                var first = (int)Native.SendMessage(Box.Handle, Native.EM_GETFIRSTVISIBLELINE, IntPtr.Zero, IntPtr.Zero);
                Native.SendMessage(Box.Handle, Native.EM_LINESCROLL, IntPtr.Zero, (IntPtr)(v - first));
            };
            Box.MouseWheel += (s, e) =>
            {
                Native.SendMessage(Box.Handle, Native.EM_LINESCROLL, IntPtr.Zero, (IntPtr)(-e.Delta / 120 * 3));
                Sync();
            };
            Box.TextChanged += (s, e) => Sync();
            Box.Resize += (s, e) => Sync();
        }

        private int VisibleLines()
        {
            var lineHeight = TextRenderer.MeasureText("Wg", Box.Font).Height;
            return Math.Max(1, Box.ClientSize.Height / Math.Max(1, lineHeight));
        }

        public void Sync()
        {
            if (!Box.IsHandleCreated) return;
            var total = (int)Native.SendMessage(Box.Handle, Native.EM_GETLINECOUNT, IntPtr.Zero, IntPtr.Zero);
            var first = (int)Native.SendMessage(Box.Handle, Native.EM_GETFIRSTVISIBLELINE, IntPtr.Zero, IntPtr.Zero);
            _bar.Configure(VisibleLines(), Math.Max(1, total), first);
        }

        /// <summary>Append to a named channel, creating its tab on first use.</summary>
        public void Append(string channel, string text)
        {
            if (string.IsNullOrEmpty(channel)) channel = "Session";
            StringBuilder buf;
            if (!_buffers.TryGetValue(channel, out buf))
            {
                buf = new StringBuilder();
                _buffers[channel] = buf;
                _order.Add(channel);
                AddTab(channel);
                if (_active == null) Select(channel);
            }
            buf.Append(text);
            if (buf.Length > BufferCap) buf.Remove(0, buf.Length - BufferCap);

            if (channel == _active)
            {
                Box.AppendText(text);
                Box.SelectionStart = Box.TextLength;
                Box.ScrollToCaret();
                Sync();
            }
        }

        public void Append(string text) { Append(_active ?? "Session", text); }

        private void AddTab(string channel)
        {
            var b = new FlatButton(channel, Math.Max(58, channel.Length * 9 + 22)) { Height = 24, Margin = new Padding(0, 0, 5, 0) };
            b.Tag = channel;
            b.Click += (s, e) => Select((string)((FlatButton)s).Tag);
            _tabs.Controls.Add(b);
            // The strip only appears once there is more than one thing in it.
            _tabs.Height = _order.Count > 1 ? 32 : 0;
        }

        public void Select(string channel)
        {
            if (!_buffers.ContainsKey(channel)) return;
            _active = channel;
            foreach (Control c in _tabs.Controls)
            {
                var b = c as FlatButton;
                if (b != null) { b.Primary = (string)b.Tag == channel; b.Invalidate(); }
            }
            Box.Text = _buffers[channel].ToString();
            Box.SelectionStart = Box.TextLength;
            Box.ScrollToCaret();
            Sync();
        }

        public void Clear()
        {
            _buffers.Clear();
            _order.Clear();
            _tabs.Controls.Clear();
            _tabs.Height = 0;
            _active = null;
            Box.Clear();
            Sync();
        }
    }
}
