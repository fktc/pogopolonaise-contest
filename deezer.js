// Deezer as the default music source: its public API needs no key and no login, and every track comes with a
// 30-second preview MP3. Browsers can't call api.deezer.com directly (no CORS), so playlists, albums, searches and
// fresh preview links go through here. The preview MP3s themselves allow CORS, the browser loads those directly.
// Deezer allows ~50 requests per 5 s per IP — that's this server's IP for all players, hence the throttle + caches.
const log = require('./log');

const API = 'https://api.deezer.com';
const MAX_TRACKS = 2000;
const CACHE_MS = 10 * 60_000;

// ---------------------------------------------------------------- throttled requests
const queue = [];
let inFlight = 0;
let windowStart = 0;
let windowCount = 0;
const PER_WINDOW = 40; // stay under 50 per 5 s

function pump() {
  while (queue.length && inFlight < 6) {
    const now = Date.now();
    if (now - windowStart > 5000) {
      windowStart = now;
      windowCount = 0;
    }
    if (windowCount >= PER_WINDOW) {
      setTimeout(pump, 5000 - (now - windowStart) + 20);
      return;
    }
    windowCount++;
    inFlight++;
    const { url, resolve, reject } = queue.shift();
    fetch(url, { signal: AbortSignal.timeout(15_000) })
      .then((r) => r.json())
      .then(resolve, reject)
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

async function get(path, attempt = 0) {
  const data = await new Promise((resolve, reject) => {
    queue.push({ url: path.startsWith('http') ? path : API + path, resolve, reject });
    pump();
  });
  if (data?.error) {
    if (data.error.code === 4 && attempt < 3) { // quota exceeded: back off and retry
      log.warn('deezer.quota', { path: path.slice(0, 60) });
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return get(path, attempt + 1);
    }
    const err = new Error(data.error.message || data.error.type || 'Deezer error');
    err.code = data.error.code;
    throw err;
  }
  return data;
}

const cache = new Map();
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await fn();
  if (cache.size > 2000) cache.clear();
  cache.set(key, { at: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------- tracks
// Only what the game needs. "preview" just says whether there is one; the link itself expires, the browser asks for
// a fresh one right before playing (track()).
function slim(t, album) {
  if (!t || t.type !== 'track' || !t.preview || t.readable === false) return null;
  const a = t.album || album || {};
  return {
    id: String(t.id),
    title: t.title_short || t.title,
    name: t.title,
    artists: t.artist?.name || '',
    album: a.title || '',
    image: a.cover_xl || a.cover_big || a.cover_medium || '',
    duration: t.duration || 0,
  };
}

async function allTracks(firstPage) {
  const tracks = [];
  let page = firstPage;
  while (page) {
    tracks.push(...(page.data || []));
    if (!page.next || tracks.length >= MAX_TRACKS) break;
    page = await get(page.next);
  }
  return tracks;
}

async function playlist(id) {
  return cached(`playlist:${id}`, async () => {
    const started = Date.now();
    const meta = await get(`/playlist/${id}`);
    const first = meta.tracks?.data?.length < meta.nb_tracks ? await get(`/playlist/${id}/tracks?limit=100`) : meta.tracks;
    const tracks = (await allTracks(first)).map((t) => slim(t)).filter(Boolean);
    log.info('deezer.playlist', { id, name: meta.title, tracks: tracks.length, of: meta.nb_tracks, ms: Date.now() - started });
    return { name: meta.title, tracks };
  });
}

async function album(id) {
  return cached(`album:${id}`, async () => {
    const meta = await get(`/album/${id}`);
    const tracks = (await allTracks(meta.tracks)).map((t) => slim(t, meta)).filter(Boolean);
    log.info('deezer.album', { id, name: meta.title, tracks: tracks.length });
    return { name: meta.title, tracks };
  });
}

// A fresh preview link (they expire after some hours).
async function track(id) {
  const t = await get(`/track/${id}`);
  return { id: String(t.id), preview: t.preview || null };
}

// ---------------------------------------------------------------- matching (e.g. Spotify playlist -> Deezer)
const norm = (s) => String(s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s*[([].*?[)\]]/g, '') // (feat. …), (Remastered) …
  .replace(/\s+-\s+.*$/, '') // " - Radio Edit"
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();
const VERSIONS = /\b(live|unplugged|karaoke|instrumental|remix|acoustic|cover|tribute|edit)\b/i;

function score(candidate, want) {
  let s = 0;
  const title = norm(candidate.title);
  const wantTitle = norm(want.name);
  if (title === wantTitle) s += 50;
  else if (title.includes(wantTitle) || wantTitle.includes(title)) s += 25;
  const artist = norm(candidate.artist?.name || '');
  const wantArtists = String(want.artists).split(',').map(norm);
  if (wantArtists.includes(artist)) s += 40;
  else if (wantArtists.some((a) => a && (artist.includes(a) || a.includes(artist)))) s += 20;
  // prefer the studio version unless the source asks for a live/remix one
  if (VERSIONS.test(candidate.title) && !VERSIONS.test(want.name)) s -= 30;
  if (!candidate.preview) s -= 100;
  return s;
}

async function findOne(want) {
  const key = `match:${norm(want.artists)}|${norm(want.name)}`;
  return cached(key, async () => {
    const firstArtist = String(want.artists).split(',')[0];
    const q = `${firstArtist} ${want.name.replace(/\s+-\s+.*$/, '')}`;
    const res = await get(`/search?limit=10&q=${encodeURIComponent(q)}`);
    const best = (res.data || []).map((c) => ({ c, s: score(c, want) })).sort((a, b) => b.s - a.s)[0];
    return best && best.s >= 50 ? slim(best.c) : null;
  });
}

async function match(list) {
  const started = Date.now();
  const results = await Promise.all(list.map((w) => findOne(w).catch(() => null)));
  log.info('deezer.match', { asked: list.length, found: results.filter(Boolean).length, ms: Date.now() - started });
  return results;
}

// link.deezer.com / deezer.page.link short links -> the real playlist/album address
async function resolve(shortUrl) {
  const u = new URL(shortUrl);
  if (!/(^|\.)deezer\.(com|page\.link)$/.test(u.hostname) && u.hostname !== 'deezer.page.link') throw new Error('Kein Deezer-Link');
  let url = shortUrl;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const next = res.headers.get('location');
    if (!next) break;
    url = new URL(next, url).toString();
    if (/\/(playlist|album)\/\d+/.test(url)) break;
  }
  const m = url.match(/\/(playlist|album)\/(\d+)/);
  if (!m) throw new Error('Der Kurzlink führt zu keiner Playlist');
  return { type: m[1], id: m[2] };
}

module.exports = { playlist, album, track, match, resolve };
