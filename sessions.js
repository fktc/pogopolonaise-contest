// Phone controllers. The game page (host) and the players' phones meet in a session: phones POST their
// presses, the host receives them over Server-Sent Events and pushes the game state back to the phones
// the same way. Plain HTTP, no WebSocket dependency. Sessions live in memory; after a server restart the
// host re-creates its session with the same id and keys, so QR codes that were already scanned keep working.
const crypto = require('node:crypto');
const log = require('./log');

const SESSION_IDLE_MS = 12 * 3600_000;
const MAX_SESSIONS = 1000;
const MAX_STREAMS = 12; // per session: a host tab or two plus phones
const TOKEN = /^[A-Za-z0-9_-]{16,32}$/;
// buzz/pass from every phone; show/correct/wrong/next let the phones run the game without a laptop.
const ACTIONS = new Set(['buzz', 'pass', 'show', 'correct', 'wrong', 'next']);

const sessions = new Map();
const newToken = () => crypto.randomBytes(12).toString('base64url');

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.touched > SESSION_IDLE_MS && !s.hosts.size && !s.phones.size) {
      sessions.delete(id);
      log.info('session.expired', { id: log.short(id), sessions: sessions.size });
    }
  }
}, 10 * 60_000).unref();

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

function readJson(req, limit = 8192) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function openStream(req, res, onClose) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
  });
  res.write('retry: 2000\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    onClose();
  });
}

function phoneCounts(s) {
  const counts = [0, 0];
  for (const phone of s.phones) counts[phone.player]++;
  return counts;
}

function notifyHosts(s, event, data) {
  for (const res of s.hosts) send(res, event, data);
}

function getSession(id) {
  const s = sessions.get(id);
  if (s) s.touched = Date.now();
  return s;
}

// POST /api/session  {id?, hostKey?, playerKeys?}  → the host's session (resumed or new)
async function createSession(req, res) {
  const body = (await readJson(req)) || {};
  const { id, hostKey, playerKeys } = body;
  const resumable = [id, hostKey, ...(Array.isArray(playerKeys) ? playerKeys : [])].every((x) => TOKEN.test(x || ''))
    && Array.isArray(playerKeys) && playerKeys.length === 2;
  if (resumable) {
    const existing = getSession(id);
    if (existing) {
      if (existing.hostKey !== hostKey) {
        log.warn('session.resume_rejected', { id: log.short(id) });
        return json(res, 403, { error: 'Wrong key for this session' });
      }
      log.info('session.resumed', { id: log.short(id), phones: phoneCounts(existing) });
      return json(res, 200, { id, hostKey, playerKeys: existing.playerKeys });
    }
  }
  if (sessions.size >= MAX_SESSIONS) {
    log.error('session.limit_reached', { sessions: sessions.size });
    return json(res, 503, { error: 'Too many sessions, try again later' });
  }
  const s = {
    id: resumable ? id : newToken(),
    hostKey: resumable ? hostKey : newToken(),
    playerKeys: resumable ? playerKeys : [newToken(), newToken()],
    hosts: new Set(),
    phones: new Set(),
    state: null,
    touched: Date.now(),
    presses: [],
  };
  sessions.set(s.id, s);
  log.info(resumable ? 'session.recreated' : 'session.created', { id: log.short(s.id), sessions: sessions.size });
  return json(res, 200, { id: s.id, hostKey: s.hostKey, playerKeys: s.playerKeys });
}

// Returns true when the request was an /api/session… route.
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/session' && req.method === 'POST') {
    await createSession(req, res);
    return true;
  }
  const m = url.pathname.match(/^\/api\/session\/([A-Za-z0-9_-]{16,32})\/(host|phone|press|state)$/);
  if (!m) return false;
  const s = getSession(m[1]);
  if (!s) {
    json(res, 404, { error: 'No such session' });
    return true;
  }

  switch (`${req.method} ${m[2]}`) {
    case 'GET host': {
      if (url.searchParams.get('key') !== s.hostKey) {
        log.warn('session.host_rejected', { id: log.short(s.id) });
        return json(res, 403, { error: 'Wrong key' }), true;
      }
      if (s.hosts.size + s.phones.size >= MAX_STREAMS) return json(res, 429, { error: 'Too many connections' }), true;
      s.hosts.add(res);
      log.info('session.host_connected', { id: log.short(s.id), hosts: s.hosts.size });
      openStream(req, res, () => {
        s.hosts.delete(res);
        log.info('session.host_disconnected', { id: log.short(s.id), hosts: s.hosts.size });
      });
      send(res, 'phones', phoneCounts(s));
      return true;
    }
    case 'GET phone': {
      const player = Number(url.searchParams.get('p'));
      if (![0, 1].includes(player) || url.searchParams.get('k') !== s.playerKeys[player]) {
        log.warn('session.phone_rejected', { id: log.short(s.id), player: url.searchParams.get('p') });
        return json(res, 403, { error: 'Wrong key' }), true;
      }
      if (s.hosts.size + s.phones.size >= MAX_STREAMS) return json(res, 429, { error: 'Too many connections' }), true;
      const phone = { res, player };
      s.phones.add(phone);
      log.info('session.phone_connected', { id: log.short(s.id), player, phones: phoneCounts(s), ua: (req.headers['user-agent'] || '').slice(0, 80) });
      openStream(req, res, () => {
        s.phones.delete(phone);
        log.info('session.phone_disconnected', { id: log.short(s.id), player, phones: phoneCounts(s) });
        notifyHosts(s, 'phones', phoneCounts(s));
      });
      if (s.state) send(res, 'state', s.state);
      notifyHosts(s, 'phones', phoneCounts(s));
      return true;
    }
    case 'POST press': {
      const body = await readJson(req, 512);
      const player = body?.p;
      if (![0, 1].includes(player) || body.k !== s.playerKeys[player] || !ACTIONS.has(body.action)) {
        log.warn('session.press_rejected', { id: log.short(s.id), player, action: body?.action });
        return json(res, 403, { error: 'Wrong key' }), true;
      }
      // A few presses a second is plenty for a buzzer; drop anything beyond that.
      const now = Date.now();
      s.presses = s.presses.filter((t) => now - t < 1000);
      if (s.presses.length >= 10) {
        log.warn('session.press_flood', { id: log.short(s.id), player });
        return json(res, 429, { error: 'Slow down' }), true;
      }
      s.presses.push(now);
      notifyHosts(s, 'press', { player, action: body.action });
      log.info('session.press', { id: log.short(s.id), player, action: body.action, delivered: s.hosts.size > 0 });
      json(res, 200, { delivered: s.hosts.size > 0 });
      return true;
    }
    case 'POST state': {
      const body = await readJson(req, 8192);
      if (!body || body.key !== s.hostKey || typeof body.state !== 'object') {
        log.warn('session.state_rejected', { id: log.short(s.id) });
        return json(res, 403, { error: 'Wrong key' }), true;
      }
      if (body.state.phase !== s.state?.phase) log.info('session.phase', { id: log.short(s.id), phase: body.state.phase, phones: phoneCounts(s) });
      s.state = body.state;
      for (const phone of s.phones) send(phone.res, 'state', s.state);
      res.writeHead(204).end();
      return true;
    }
    default:
      json(res, 405, { error: 'Method not allowed' });
      return true;
  }
}

module.exports = { handle };
