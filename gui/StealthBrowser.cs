// StealthBrowser GUI launcher.
//
// A front end over the same Node launcher the .cmd files run: it edits
// config.json, starts sessions, replays macros, and streams output back.
//
// The settings surface is data-driven. Every control is registered with the
// config path it maps to, so loading and saving are two loops rather than a
// hundred hand-written assignments - which is what keeps it feasible to expose
// the whole config rather than a convenient subset.
//
// Built with the csc.exe that ships with Windows: no SDK, no packages.
// Build:  build-exe.cmd
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.NetworkInformation;
using System.Text;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace StealthBrowser
{
    public static class Program
    {
        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    /// <summary>Reads and writes the nested config.json without a JSON library.</summary>
    internal class ConfigModel
    {
        private Dictionary<string, object> _root = new Dictionary<string, object>();
        public string SourceFile = "";

        public void Load(string json)
        {
            var ser = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
            var top = ser.Deserialize<Dictionary<string, object>>(json);
            object f;
            if (top.TryGetValue("configFile", out f) && f != null) SourceFile = f.ToString();
            object cfg;
            _root = top.TryGetValue("config", out cfg) && cfg is Dictionary<string, object>
                ? (Dictionary<string, object>)cfg
                : top;
        }

        public object Raw(string path)
        {
            object node = _root;
            foreach (var p in path.Split('.'))
            {
                var dict = node as Dictionary<string, object>;
                if (dict == null || !dict.ContainsKey(p)) return null;
                node = dict[p];
            }
            return node;
        }

        public string GetString(string path, string fallback)
        {
            var v = Raw(path);
            return v == null ? fallback : v.ToString();
        }

        public bool GetBool(string path, bool fallback)
        {
            var v = Raw(path);
            return v is bool ? (bool)v : fallback;
        }

        public int GetInt(string path, int fallback)
        {
            var v = Raw(path);
            if (v == null) return fallback;
            int n;
            return int.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), out n) ? n : fallback;
        }

        public decimal GetDecimal(string path, decimal fallback)
        {
            var v = Raw(path);
            if (v == null) return fallback;
            decimal n;
            return decimal.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture),
                NumberStyles.Any, CultureInfo.InvariantCulture, out n) ? n : fallback;
        }

        public List<string> GetList(string path)
        {
            var v = Raw(path) as System.Collections.IEnumerable;
            var outp = new List<string>();
            if (v != null && !(v is string))
                foreach (var item in v) if (item != null) outp.Add(item.ToString());
            return outp;
        }

        public void Set(string path, object value)
        {
            var parts = path.Split('.');
            var node = _root;
            for (int i = 0; i < parts.Length - 1; i++)
            {
                if (!node.ContainsKey(parts[i]) || !(node[parts[i]] is Dictionary<string, object>))
                    node[parts[i]] = new Dictionary<string, object>();
                node = (Dictionary<string, object>)node[parts[i]];
            }
            node[parts[parts.Length - 1]] = value;
        }

        public string ToPrettyJson() { return Pretty(_root, 0); }

        /// <summary>
        /// JavaScriptSerializer only emits compact JSON, and this file is meant
        /// to stay editable by hand afterwards.
        /// </summary>
        private static string Pretty(object value, int depth)
        {
            var pad = new string(' ', (depth + 1) * 2);
            var padEnd = new string(' ', depth * 2);

            var dict = value as Dictionary<string, object>;
            if (dict != null)
            {
                if (dict.Count == 0) return "{}";
                var sb = new StringBuilder("{\n");
                int i = 0;
                foreach (var kv in dict)
                {
                    sb.Append(pad).Append(Quote(kv.Key)).Append(": ").Append(Pretty(kv.Value, depth + 1));
                    if (++i < dict.Count) sb.Append(',');
                    sb.Append('\n');
                }
                return sb.Append(padEnd).Append('}').ToString();
            }

            var list = value as System.Collections.IEnumerable;
            if (list != null && !(value is string))
            {
                var items = list.Cast<object>().ToList();
                if (items.Count == 0) return "[]";
                var sb = new StringBuilder("[\n");
                for (int i = 0; i < items.Count; i++)
                {
                    sb.Append(pad).Append(Pretty(items[i], depth + 1));
                    if (i < items.Count - 1) sb.Append(',');
                    sb.Append('\n');
                }
                return sb.Append(padEnd).Append(']').ToString();
            }

            if (value == null) return "null";
            if (value is bool) return ((bool)value) ? "true" : "false";
            if (value is int || value is long || value is double || value is decimal)
                return Convert.ToString(value, CultureInfo.InvariantCulture);
            return Quote(value.ToString());
        }

        private static string Quote(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }
    }

    /// <summary>
    /// A dropdown entry whose visible label is richer than the value it stores,
    /// so "lan2" can be shown as the adapter it actually means.
    /// </summary>
    internal class ComboItem
    {
        public readonly string Value;
        public readonly string Label;
        public ComboItem(string value, string label) { Value = value; Label = label; }
        public override string ToString() { return Label; }
    }

    /// <summary>One setting: a control plus the config path and shape it maps to.</summary>
    internal class Field
    {
        public string Path;
        public Control Ctl;
        public string Kind;         // bool | text | textOrNull | int | intOrNull | dec | lines | csv | tri
        public object Fallback;
        // Which view owns this control. Simple and Advanced map onto the same
        // config paths, so only the visible view is read back - otherwise the
        // hidden copy would quietly overwrite what the user just changed.
        public string Mode;
    }

}
