#!/usr/bin/env node
// Tiny static file server for the game.
// Locally: Spotify only accepts loopback IPs (not "localhost") as http redirect URIs, so we bind to
// 127.0.0.1 — register http://127.0.0.1:8888/ in your Spotify app.
// On a server: run behind an HTTPS reverse proxy with NO_OPEN=1, TRUST_PROXY=1 and SPOTIFY_CLIENT_ID set.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const log = require('./log');
const sessions = require('./sessions');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8888;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || ''; // optional: saves visitors from entering one
const TRUST_PROXY = Boolean(process.env.TRUST_PROXY); // take the client IP from X-Real-IP
// Phones as buzzers only make sense where phones can reach the server, i.e. the hosted version.
const PHONES = Boolean(process.env.PHONE_CONTROLLERS);
const ROOT = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const clientIp = (req) => (TRUST_PROXY && req.headers['x-real-ip']) || req.socket.remoteAddress;

// Per-IP request budget for the endpoints that do work (fixed one-minute windows).
const hits = new Map();
function allowed(req, bucket, perMinute) {
  const ip = clientIp(req);
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.start > 60_000) {
    if (hits.size > 10_000) hits.clear();
    hits.set(key, { start: now, count: 1 });
    return true;
  }
  if (++entry.count <= perMinute) return true;
  if (entry.count === perMinute + 1) log.warn('rate_limited', { bucket, ip }); // once per window
  return false;
}

// Playlist pages barely change during a party; don't ask Spotify again for every game.
const embedCache = new Map();
const EMBED_TTL_MS = 10 * 60_000;

// Browser diagnostics (debugLog in app.js / phone.html) arrive as {tab, role, msg}.
function logClient(body) {
  let entry;
  try {
    entry = JSON.parse(body);
  } catch {
    entry = { msg: body };
  }
  const msg = String(entry.msg ?? '').slice(0, 2000).replace(/[\r\n]+/g, ' ');
  const fields = { tab: String(entry.tab ?? '?').slice(0, 12), role: String(entry.role ?? '?').slice(0, 8), msg };
  (entry.level === 'error' ? log.error : log.info)('client', fields);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/config.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }).end(JSON.stringify({ clientId: CLIENT_ID, phones: PHONES }));
    return;
  }
  if (PHONES && req.url.startsWith('/api/')) {
    if (req.method === 'POST' && req.url === '/api/session' && !allowed(req, 'session', 20)) {
      res.writeHead(429).end();
      return;
    }
    sessions.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    }).catch((err) => {
      log.error('api.failed', { method: req.method, path: req.url.split('?')[0], error: err.stack || err.message });
      if (!res.headersSent) res.writeHead(500).end();
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/log') {
    if (!allowed(req, 'log', 120)) {
      res.writeHead(429).end();
      req.resume();
      return;
    }
    let body = '';
    req.on('data', (chunk) => { if (body.length < 4000) body += chunk; });
    req.on('end', () => {
      logClient(body);
      res.writeHead(204).end();
    });
    return;
  }
  // Spotify's API won't let Development Mode apps read playlists owned by other people, but the public
  // embed page lists them (up to 100 songs). Browsers can't fetch it cross-origin, so we do it here.
  const embed = req.url.match(/^\/embed\/(playlist|album)\/([A-Za-z0-9]{22})$/);
  if (req.method === 'GET' && embed) {
    if (!allowed(req, 'embed', 60)) {
      res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Too many requests, try again in a minute' }));
      return;
    }
    fetchEmbedCached(embed[1], embed[2])
      .then((data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data)))
      .catch((err) => {
        log.warn('embed.failed', { type: embed[1], id: embed[2], error: err.message });
        res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      });
    return;
  }
  let file;
  try {
    const { pathname } = new URL(req.url, `http://${HOST}`);
    file = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
    if (pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (pathname === '/mobile') file = path.join(ROOT, 'index.html'); // phone version, same page
    if (pathname === '/mobile/') {
      res.writeHead(301, { Location: '/mobile' }).end(); // keep relative asset paths working
      return;
    }
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res
      .writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      })
      .end(data);
  });
});

async function fetchEmbedCached(type, id) {
  const key = `${type}/${id}`;
  const hit = embedCache.get(key);
  if (hit && Date.now() - hit.at < EMBED_TTL_MS) {
    log.info('embed.cached', { type, id, tracks: hit.data.tracks.length });
    return hit.data;
  }
  const started = Date.now();
  const data = await fetchEmbed(type, id);
  log.info('embed.fetched', { type, id, name: data.name, tracks: data.tracks.length, ms: Date.now() - started });
  if (embedCache.size > 500) embedCache.clear();
  embedCache.set(key, { at: Date.now(), data });
  return data;
}

async function fetchEmbed(type, id) {
  const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Spotify embed page answered ${res.status}`);
  const html = await res.text();
  const json = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  const entity = json && JSON.parse(json).props?.pageProps?.state?.data?.entity;
  if (!entity?.trackList) throw new Error('Could not read the songs from Spotify\'s embed page');
  return {
    name: entity.name || entity.title,
    owner: entity.subtitle || '',
    tracks: entity.trackList
      .filter((t) => t.entityType === 'track' && t.uri?.startsWith('spotify:track:'))
      .map((t) => ({ uri: t.uri, name: t.title, artists: t.subtitle || '', durationMs: t.duration || 0, playable: t.isPlayable !== false })),
  };
}

process.on('uncaughtException', (err) => {
  log.error('crash.uncaught', { error: err.stack || err.message });
  process.exit(1); // pm2 restarts us; the host re-creates its phone session automatically
});
process.on('unhandledRejection', (err) => log.error('crash.unhandled_rejection', { error: err?.stack || String(err) }));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error('server.port_in_use', { port: PORT, hint: 'stop the other process or run with PORT=xxxx (and update the Redirect URI in your Spotify app)' });
  } else {
    log.error('server.error', { error: err.stack || err.message });
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  log.info('server.started', { url, phones: PHONES, clientId: CLIENT_ID ? 'set' : 'not set', trustProxy: TRUST_PROXY, node: process.version });
  if (!process.env.NO_OPEN) {
    console.log(`\n  ★  Pogo & Polonaise läuft auf ${url}\n      (Ctrl+C to stop)\n`);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${opener} ${url}`);
  }
});
