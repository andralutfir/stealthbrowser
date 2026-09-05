'use strict';
/** Network interface discovery + alias resolution ("wifi", "lan", "vpn", ...). */
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const WIFI_RE = /wi[\s-]?fi|wireless|wlan|wlp|airport|en1\b/i;
const ETH_RE = /ethernet|eth\d|enp|eno|ens|local area connection|en0\b/i;
const VPN_RE = /vpn|nordlynx|wg\d|wireguard|tun\d|tap\d|openvpn|proton|mullvad|tailscale|zerotier|utun/i;
const VIRTUAL_RE = /vethernet|virtualbox|vmware|hyper-v|docker|npcap|loopback|bluetooth|default switch|wsl/i;

function classify(name) {
  if (VPN_RE.test(name)) return 'vpn';
  if (VIRTUAL_RE.test(name)) return 'virtual';
  if (WIFI_RE.test(name)) return 'wifi';
  if (ETH_RE.test(name)) return 'ethernet';
  return 'other';
}

/**
 * Linux publishes link state under /sys, which is the same thing Get-NetAdapter
 * gives on Windows: it lets a cable that is plugged in but dead be ranked below
 * one that works, instead of both looking equally usable.
 */
function linuxAdapterInfo() {
  if (process.platform !== 'linux') return {};
  const map = {};
  try {
    for (const name of fs.readdirSync('/sys/class/net')) {
      let state = '';
      try { state = fs.readFileSync(`/sys/class/net/${name}/operstate`, 'utf8').trim(); } catch {}
      let wireless = false;
      try { wireless = fs.existsSync(`/sys/class/net/${name}/wireless`); } catch {}
      map[name] = {
        Status: state === 'up' ? 'Up' : state === 'down' ? 'Down' : undefined,
        MediaType: wireless ? '802.11' : undefined,
      };
    }
  } catch { /* not every system exposes it */ }
  return map;
}

/** Windows exposes real media type + link state; use it when available. */
function windowsAdapterInfo() {
  if (process.platform !== 'win32') return {};
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-NetAdapter | Select-Object Name,InterfaceDescription,Status,LinkSpeed,MediaType | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const map = {};
    for (const a of list) if (a && a.Name) map[a.Name] = a;
    return map;
  } catch { return {}; }
}

function listInterfaces({ includeInternal = false } = {}) {
  const winInfo = process.platform === 'win32' ? windowsAdapterInfo() : linuxAdapterInfo();
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces() || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal && !includeInternal) continue;
      const w = winInfo[name];
      let kind = classify(name);
      if (w && w.MediaType && /802\.11|native/i.test(w.MediaType)) kind = kind === 'virtual' ? kind : 'wifi';
      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        mac: a.mac,
        internal: !!a.internal,
        kind,
        status: w ? w.Status : undefined,
        description: w ? w.InterfaceDescription : undefined,
        linkSpeed: w ? w.LinkSpeed : undefined,
      });
    }
  }
  // Prefer up + non-virtual interfaces first.
  const rank = (i) => (i.kind === 'virtual' ? 3 : i.status === 'Down' ? 2 : 0);
  return out.sort((x, y) => rank(x) - rank(y));
}

/**
 * Resolve a config value into a concrete local IPv4 address to bind to.
 * Accepts: "auto" | "wifi" | "lan"/"ethernet" | "vpn" | an interface name | an IP.
 */
function resolveInterface(spec) {
  if (!spec || spec === 'auto' || spec === 'default') return null;
  const ifaces = listInterfaces();
  const s = String(spec).trim();

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const hit = ifaces.find((i) => i.address === s);
    if (!hit) throw new Error(`No interface has the IP ${s}. Run: node src/index.js --list-interfaces`);
    return hit;
  }

  const alias = s.toLowerCase();
  const byAlias = { wifi: 'wifi', 'wi-fi': 'wifi', wireless: 'wifi', wlan: 'wifi', lan: 'ethernet', ethernet: 'ethernet', kabel: 'ethernet', vpn: 'vpn' };

  // Aliases may carry a number - lan2, wifi2 - which picks the nth adapter of
  // that kind in the order --list-interfaces shows them. That keeps the short
  // names usable on a machine with two Ethernet ports without ever leaving the
  // choice to enumeration order.
  const m = alias.match(/^([a-z-]+?)\s*([1-9][0-9]*)?$/);
  const base = m && byAlias[m[1]] ? m[1] : null;
  if (base) {
    const kind = byAlias[base];
    const wanted = m[2] ? parseInt(m[2], 10) : null;
    const matches = ifaces.filter((i) => i.kind === kind && i.status !== 'Down');
    if (!matches.length) throw new Error(`No active "${kind}" interface. Run: node src/index.js --list-interfaces`);

    if (wanted !== null) {
      if (wanted > matches.length) {
        throw new Error(`"${spec}" asks for ${kind} #${wanted}, but only ${matches.length} ${matches.length === 1 ? 'is' : 'are'} active. `
          + 'Run: node src/index.js --list-interfaces');
      }
      return matches[wanted - 1];
    }

    // A bare alias with several candidates would be a coin flip, and believing
    // traffic left by one adapter while it left by another is exactly the kind
    // of quiet mistake this tool exists to avoid.
    if (matches.length > 1) {
      const list = matches.map((i, n) =>
        `    ${base}${n + 1}   ${i.name}  (${i.address})${i.description ? '  ' + i.description : ''}`).join('\n');
      throw new Error(
        `"${spec}" matches ${matches.length} active ${kind} interfaces - pick one:\n${list}\n`
        + `  e.g. --interface ${base}2   or   --interface "${matches[1].name}"   or   --interface ${matches[1].address}`);
    }
    return matches[0];
  }

  const exact = ifaces.find((i) => i.name.toLowerCase() === alias)
    || ifaces.find((i) => i.name.toLowerCase().includes(alias));
  if (!exact) throw new Error(`Interface "${spec}" not found. Run: node src/index.js --list-interfaces`);
  return exact;
}

function formatInterfaces() {
  const list = listInterfaces({ includeInternal: true });
  const w = Math.max(4, ...list.map((i) => i.name.length));
  return list.map((i) => {
    const flags = [i.kind, i.status, i.internal ? 'internal' : null].filter(Boolean).join(', ');
    let line = `  ${i.name.padEnd(w)}  ${i.address.padEnd(15)}  (${flags})`;
    // The hardware description is what tells two Ethernet adapters apart.
    if (i.description) line += `\n  ${' '.repeat(w)}  ${' '.repeat(15)}   ${i.description}`;
    return line;
  }).join('\n');
}

module.exports = { listInterfaces, resolveInterface, formatInterfaces };
