'use strict';
/** Monitor detection and window tiling for multi-instance mode. */
const { execFileSync } = require('child_process');

let cachedMonitor = null;

/** Usable desktop area, i.e. the screen minus the taskbar. */
function getMonitor(override) {
  if (override && override.width && override.height) {
    return { width: override.width, height: override.height, left: override.left || 0, top: override.top || 0, source: 'config' };
  }
  if (cachedMonitor) return cachedMonitor;

  let result = { width: 1920, height: 1040, left: 0, top: 0, source: 'default' };
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $a=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; "$($a.X) $($a.Y) $($a.Width) $($a.Height)"',
      ], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
      const [x, y, w, h] = out.split(/\s+/).map(Number);
      if (w > 0 && h > 0) result = { left: x, top: y, width: w, height: h, source: 'windows' };
    } catch {}
  } else if (process.platform === 'darwin') {
    try {
      const out = execFileSync('system_profiler', ['SPDisplaysDataType'], { encoding: 'utf8', timeout: 10000 });
      const m = out.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/);
      if (m) result = { left: 0, top: 25, width: Number(m[1]), height: Number(m[2]) - 25, source: 'macos' };
    } catch {}
  } else {
    try {
      const out = execFileSync('xrandr', [], { encoding: 'utf8', timeout: 8000 });
      const m = out.match(/current\s+(\d+)\s*x\s*(\d+)/);
      if (m) result = { left: 0, top: 0, width: Number(m[1]), height: Number(m[2]) - 40, source: 'xrandr' };
    } catch {}
  }
  cachedMonitor = result;
  return result;
}

// Chromium refuses to render a window narrower than this and silently widens it,
// which would make neighbouring tiles overlap.
const MIN_TILE_WIDTH = 400;
const MIN_TILE_HEIGHT = 300;

/**
 * Split the monitor into `count` slots.
 *
 * "tile" keeps a single row for up to `maxPerRow` windows - tall, narrow columns
 * so several browsers sit side by side on one screen - and wraps into extra rows
 * beyond that. "cascade" offsets each window by a fixed step. "none" leaves the
 * geometry to each instance's own persona.
 *
 * @returns {Array<{left:number, top:number, width:number, height:number}>|null}
 */
function computeTiles(count, opts = {}) {
  const layout = opts.layout || 'tile';
  if (layout === 'none' || count <= 0) return null;

  const mon = getMonitor(opts.monitor);
  const gap = Number.isFinite(opts.gap) ? opts.gap : 0;

  if (layout === 'cascade') {
    const step = opts.step || 32;
    const w = Math.round(mon.width * 0.6);
    const h = Math.round(mon.height * 0.8);
    return Array.from({ length: count }, (_, i) => ({
      left: mon.left + Math.min(i * step, Math.max(0, mon.width - w)),
      top: mon.top + Math.min(i * step, Math.max(0, mon.height - h)),
      width: w,
      height: h,
    }));
  }

  const maxPerRow = opts.columns || Math.min(count, opts.maxPerRow || 6);
  const columns = Math.max(1, Math.min(count, maxPerRow));
  const rows = Math.ceil(count / columns);

  const tileW = Math.floor((mon.width - gap * (columns - 1)) / columns);
  const tileH = Math.floor((mon.height - gap * (rows - 1)) / rows);

  const width = Math.max(MIN_TILE_WIDTH, tileW);
  const height = Math.max(MIN_TILE_HEIGHT, tileH);

  const tiles = [];
  for (let i = 0; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    tiles.push({
      left: mon.left + col * (tileW + gap),
      top: mon.top + row * (tileH + gap),
      width,
      height,
    });
  }
  return tiles;
}

function describeLayout(count, tiles, opts = {}) {
  const mon = getMonitor(opts.monitor);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (!tiles) return `${plural(count, 'instance')}, free window placement (layout: none)`;
  const t = tiles[0];
  const columns = tiles.filter((x) => x.top === tiles[0].top).length;
  const rows = Math.ceil(count / columns);
  const clamped = t.width > Math.floor(mon.width / columns) ? '  (widened to the Chromium minimum, tiles may overlap)' : '';
  return `${plural(count, 'instance')}, ${plural(columns, 'column')} x ${plural(rows, 'row')}`
    + ` @ ${t.width}x${t.height} on a ${mon.width}x${mon.height} monitor${clamped}`;
}

module.exports = { getMonitor, computeTiles, describeLayout };
