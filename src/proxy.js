'use strict';
/**
 * Local HTTP/CONNECT proxy on 127.0.0.1.
 *
 * Why it exists: Chromium has no flag to pick an outgoing network interface.
 * Routing the browser through a proxy we control lets us open every upstream
 * socket with an explicit `localAddress`, which is what actually forces traffic
 * out of the chosen WiFi / LAN / VPN adapter. It also gives us authenticated
 * SOCKS5 support (Chromium has none) and a hostname blocklist.
 */
const net = require('net');
const http = require('http');
const dns = require('dns');
const { URL } = require('url');

function parseUpstream(spec) {
  if (!spec) return null;
  const u = new URL(spec.includes('://') ? spec : `http://${spec}`);
  const protocol = u.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h', 'socks'].includes(protocol)) {
    throw new Error(`Unsupported proxy scheme: ${protocol}`);
  }
  return {
    type: protocol.startsWith('socks') ? 'socks5' : 'http',
    host: u.hostname,
    port: Number(u.port) || (protocol.startsWith('socks') ? 1080 : 8080),
    username: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null,
    label: `${protocol}://${u.hostname}:${u.port || ''}`,
  };
}

class LocalProxy {
  /**
   * @param {object}   opts
   * @param {string?}  opts.localAddress source IP to bind every upstream socket to
   * @param {object?}  opts.upstream     parsed upstream proxy
   * @param {string[]} opts.dnsServers   custom resolvers (empty = system)
   * @param {string[]} opts.blockHosts   hostname suffixes to refuse
   */
  constructor(opts = {}) {
    this.localAddress = opts.localAddress || undefined;
    this.upstream = opts.upstream || null;
    this.blockHosts = (opts.blockHosts || []).map((h) => h.toLowerCase().replace(/^\./, ''));
    this.stats = { requests: 0, tunnels: 0, blocked: 0, errors: 0 };
    this.verbose = !!opts.verbose;
    this._dnsCache = new Map();

    this.resolver = null;
    if (this.localAddress) {
      // c-ares lets us bind DNS queries to the same adapter, so name lookups do
      // not leak out of the default route while traffic uses another one.
      try {
        this.resolver = new dns.Resolver();
        this.resolver.setLocalAddress(this.localAddress);
        const servers = (opts.dnsServers && opts.dnsServers.length)
          ? opts.dnsServers
          : dns.getServers().filter((s) => !s.includes(':'));
        if (servers.length) this.resolver.setServers(servers);
      } catch { this.resolver = null; }
    } else if (opts.dnsServers && opts.dnsServers.length) {
      this.resolver = new dns.Resolver();
      this.resolver.setServers(opts.dnsServers);
    }

    this.server = http.createServer();
    this.server.on('request', (req, res) => this._onRequest(req, res));
    this.server.on('connect', (req, socket, head) => this._onConnect(req, socket, head));
    this.server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch {} });
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() { try { this.server.close(); } catch {} }

  isBlocked(host) {
    if (!this.blockHosts.length) return false;
    const h = String(host).toLowerCase();
    return this.blockHosts.some((b) => h === b || h.endsWith('.' + b));
  }

  async _resolve(host) {
    if (!this.resolver || net.isIP(host)) return host;
    const cached = this._dnsCache.get(host);
    if (cached && cached.expires > Date.now()) return cached.address;
    try {
      const addrs = await new Promise((resolve, reject) => {
        this.resolver.resolve4(host, (err, a) => (err ? reject(err) : resolve(a)));
      });
      if (addrs && addrs.length) {
        const address = addrs[0];
        this._dnsCache.set(host, { address, expires: Date.now() + 60000 });
        return address;
      }
    } catch { /* fall through to OS resolution */ }
    return host;
  }

  /** Open a socket to (host, port), through the upstream proxy if configured. */
  async _dial(host, port) {
    if (!this.upstream) {
      const address = await this._resolve(host);
      return this._rawConnect(address, port, host);
    }
    const hop = await this._rawConnect(this.upstream.host, this.upstream.port, this.upstream.host);
    if (this.upstream.type === 'socks5') await socks5Handshake(hop, this.upstream, host, port);
    else await httpConnectHandshake(hop, this.upstream, host, port);
    return hop;
  }

  _rawConnect(address, port, servername) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: address, port: Number(port), localAddress: this.localAddress });
      sock.setNoDelay(true);
      sock.setTimeout(30000);
      const fail = (e) => { sock.destroy(); reject(new Error(`connect ${servername}:${port} failed: ${e.message}`)); };
      sock.once('error', fail);
      sock.once('timeout', () => fail(new Error('timeout')));
      sock.once('connect', () => {
        sock.setTimeout(0);
        sock.removeListener('error', fail);
        resolve(sock);
      });
    });
  }

  async _onConnect(req, clientSocket, head) {
    const [host, port] = splitHostPort(req.url, 443);
    this.stats.tunnels++;
    if (this.isBlocked(host)) {
      this.stats.blocked++;
      if (this.verbose) console.log(`[proxy] BLOCK ${host}`);
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    try {
      const upstream = await this._dial(host, port);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: stealthbrowser\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      const kill = () => { upstream.destroy(); clientSocket.destroy(); };
      upstream.on('error', kill);
      clientSocket.on('error', kill);
      upstream.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => upstream.destroy());
    } catch (e) {
      this.stats.errors++;
      if (this.verbose) console.log(`[proxy] ERR ${host}: ${e.message}`);
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
    }
  }

  async _onRequest(req, res) {
    this.stats.requests++;
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    if (this.isBlocked(target.hostname)) {
      this.stats.blocked++;
      res.writeHead(403).end();
      return;
    }
    try {
      const port = Number(target.port) || 80;
      const socket = await this._dial(target.hostname, port);
      const headers = { ...req.headers };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      headers.connection = 'close';
      const proxied = http.request({
        createConnection: () => socket,
        method: req.method,
        // An upstream HTTP proxy expects the absolute-form URI; an origin server does not.
        path: this.upstream && this.upstream.type === 'http' ? req.url : target.pathname + target.search,
        headers,
        host: target.hostname,
        port,
      }, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      proxied.on('error', (e) => {
        this.stats.errors++;
        if (this.verbose) console.log(`[proxy] ERR ${target.hostname}: ${e.message}`);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(proxied);
    } catch (e) {
      this.stats.errors++;
      if (this.verbose) console.log(`[proxy] ERR ${target.hostname}: ${e.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  }
}

function splitHostPort(str, defaultPort) {
  const i = str.lastIndexOf(':');
  if (i === -1) return [str, defaultPort];
  return [str.slice(0, i), Number(str.slice(i + 1)) || defaultPort];
}

function httpConnectHandshake(sock, up, host, port) {
  return new Promise((resolve, reject) => {
    let head = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
    if (up.username) {
      const cred = Buffer.from(`${up.username}:${up.password || ''}`).toString('base64');
      head += `Proxy-Authorization: Basic ${cred}\r\n`;
    }
    head += '\r\n';
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      sock.removeListener('data', onData);
      const status = parseInt(buf.split(' ')[1], 10);
      if (status !== 200) { sock.destroy(); reject(new Error(`Upstream proxy refused CONNECT (${status})`)); return; }
      const rest = Buffer.from(buf.slice(end + 4), 'latin1');
      if (rest.length) sock.unshift(rest);
      resolve();
    };
    sock.on('data', onData);
    sock.once('error', reject);
    sock.write(head);
  });
}

function socks5Handshake(sock, up, host, port) {
  return new Promise((resolve, reject) => {
    const steps = [];
    const useAuth = !!up.username;
    let buf = Buffer.alloc(0);
    const need = (n, cb) => steps.push({ n, cb });

    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      while (steps.length && buf.length >= steps[0].n) {
        const step = steps.shift();
        const chunk = buf.subarray(0, step.n);
        buf = buf.subarray(step.n);
        try { step.cb(chunk); } catch (e) { cleanup(); reject(e); return; }
      }
    };
    const cleanup = () => { sock.removeListener('data', onData); sock.removeListener('error', onErr); };
    const onErr = (e) => { cleanup(); reject(e); };
    sock.on('data', onData);
    sock.once('error', onErr);

    function sendConnect() {
      const h = Buffer.from(host, 'utf8');
      sock.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]));
      need(4, (r) => {
        if (r[1] !== 0x00) throw new Error(`SOCKS5 connect refused (code ${r[1]})`);
        const atyp = r[3];
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : -1;
        if (addrLen === -1) need(1, (l) => need(l[0] + 2, () => { cleanup(); resolve(); }));
        else need(addrLen + 2, () => { cleanup(); resolve(); });
      });
    }

    need(2, (r) => {
      if (r[0] !== 0x05) throw new Error('Invalid SOCKS5 reply');
      if (r[1] === 0xff) throw new Error('SOCKS5 rejected every authentication method');
      if (r[1] === 0x02) {
        if (!useAuth) throw new Error('SOCKS5 requires authentication but no credentials were given');
        const u = Buffer.from(up.username, 'utf8');
        const p = Buffer.from(up.password || '', 'utf8');
        sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        need(2, (a) => {
          if (a[1] !== 0x00) throw new Error('SOCKS5 authentication failed');
          sendConnect();
        });
      } else {
        sendConnect();
      }
    });

    const methods = useAuth ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));
  });
}

module.exports = { LocalProxy, parseUpstream };
