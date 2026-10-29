'use strict';

// Spotify only accepts loopback IPs (not "localhost") as http redirect URIs.
if (location.hostname === 'localhost') location.replace(location.href.replace('localhost', '127.0.0.1'));

// /mobile is the phone-only version: same game, phone layout, and the music plays on a Spotify Connect
// device (e.g. the Spotify app) because mobile browsers can't run Spotify's in-browser player.
const MOBILE = location.pathname.replace(/\/+$/, '') === '/mobile';
// Spotify sends every login back to "/" (the registered redirect URI); hop back if it started on /mobile.
const RETURNING_TO_MOBILE = !MOBILE && /[?&](code|error)=/.test(location.search) && localStorage.getItem('msc.returnTo') === '/mobile';
if (RETURNING_TO_MOBILE) {
  localStorage.removeItem('msc.returnTo');
  location.replace(`/mobile${location.search}`);
}

const API = 'https://api.spotify.com/v1';
const API_TIMEOUT_MS = 8_000; // a hanging request is abandoned after this and retried
const API_TIMEOUT_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_S = 10; // longer "Retry-After" waits are reported instead of sat out
const NOT_REGISTERED = 'Dieses Spotify-Konto darf die App noch nicht nutzen. Solange sie im Development Mode ist, '
  + 'muss der Besitzer das Konto (Name + E-Mail) unter User Management auf developer.spotify.com/dashboard eintragen.';
const REDIRECT_URI = `${location.origin}/`;
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
];
const LS = {
  clientId: 'msc.clientId',
  tokens: 'msc.tokens',
  settings: 'msc.settings',
  recent: 'msc.recent', // playlists and albums that loaded, newest first
  scoreboard: 'msc.scoreboard', // { [player name]: { won, lost, drawn } } over all finished games
  verifier: 'msc.verifier',
  volume: 'msc.volume',
  phoneSession: 'msc.phoneSession',
  device: 'msc.device', // Spotify Connect device chosen in the phone version
  menuMusic: 'msc.menuMusic',
};
const DEFAULT_SETTINGS = {
  playlists: '', // own playlist links (Spotify, or Deezer as an addition to the mixes)
  mixes: ['drei-akkorde'], // ready-made Deezer mixes, see MIXES
  customLinks: false, // Deezer mode: own links only count while that part of the setup is open
  names: ['Team Nieten', 'Team Pailletten'],
  target: 50,
  limit: 30,
  startPos: 'intro',
  penalty: false,
  passFactor: 0.5, // the other player's points when someone says "don't know"
  source: 'deezer', // 'deezer' (no login, 30 s previews) or 'spotify' (full songs, Premium)
};
// Ready-made song mixes for Deezer games, so nobody has to look for playlist links. "Drei Akkorde" ships with the
// game (public/mixes/), the others are public Deezer playlists, mostly kept up to date by Deezer's own editors.
const MIXES = [
  { id: 'drei-akkorde', name: 'Drei Akkorde', info: 'Punk × Schlager – der Mix zum Spiel', file: 'mixes/drei-akkorde.json' },
  { id: 'schlager', name: 'Schlager', info: 'Schlager Super Hits', deezer: '8699026122' },
  { id: 'malle', name: 'Malle', info: 'Endlich wieder Malle', deezer: '10328601542' },
  { id: 'punk', name: 'Deutschpunk', info: 'Wizo, Hosen, Slime & Co.', deezer: '13772623141' },
  { id: 'apres-ski', name: 'Après-Ski', info: 'Hüttengaudi', deezer: '12244014291' },
  { id: 'ndw', name: 'NDW', info: 'Neue Deutsche Welle', deezer: '6758361584' },
];
const BUZZ_KEYS = { a: 0, l: 1 };
const PASS_KEYS = { s: 0, k: 1 };
// The opponent of whoever buzzed judges the answer: Q/W for player 1, I/O for player 2.
const JUDGE_KEYS = { q: [0, true], w: [0, false], i: [1, true], o: [1, false] };
const KEY_LABELS = [{ buzz: 'A', pass: 'S', right: 'Q', wrong: 'W' }, { buzz: 'L', pass: 'K', right: 'I', wrong: 'O' }];
const RING_CIRCUMFERENCE = 2 * Math.PI * 56;
const MAX_POINTS = 10; // for an instant buzz, sliding down to 1 point at the buzzer
const WRONG_PENALTY = 2;
const OUTRO_MS = 5000; // after "next song" the current one keeps playing this long…
const OUTRO_FADE_MS = 1500; // …fading out over its last part
const QUICK_FADE_MS = 350; // Enter again during the outro skips the wait
const FADE_IN_MS = 2500; // the new song swells in from the hand-over level
// Spotify streams one song at a time per account, so a real overlap is impossible. Instead the old song
// fades down to this fraction of the volume and the new one starts there and fades up — a DJ-style blend.
const HANDOVER_LEVEL = 0.1;
const SETTINGS_VERSION = 2;

const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
  del(key) { localStorage.removeItem(key); },
};

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

// a: a track object from the Web Playback SDK, t: one of our tracks.
// Spotify often plays a relinked copy (other ID, same song) for your country, so fall back to the name.
const sameTrack = (a, t) => Boolean(a && t && (
  a.uri === t.uri || a.linked_from?.uri === t.uri || a.id === t.id
  || (a.name && a.name.toLowerCase() === t.name.toLowerCase())
));

// Mirror diagnostics into the server log (terminal locally, `pm2 logs songcontest` when hosted). Each browser
// tab gets a short random tag so several games running at once can be told apart in the log.
const LOG_TAB = Math.random().toString(36).slice(2, 8);
function sendLog(level, parts) {
  const msg = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  (level === 'error' ? console.error : console.log)('[msc]', msg);
  fetch('/log', { method: 'POST', body: JSON.stringify({ tab: LOG_TAB, role: MOBILE ? 'mobile' : 'host', level, msg }), keepalive: true }).catch(() => {});
}
const debugLog = (...parts) => sendLog('info', parts);
const errorLog = (...parts) => sendLog('error', parts);

addEventListener('error', (e) => errorLog('uncaught:', e.message, `${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno}`));
addEventListener('unhandledrejection', (e) => errorLog('unhandled rejection:', e.reason?.stack || String(e.reason)));

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ====================================================================== auth (PKCE)

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => chars[b % chars.length]).join('');
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function tokenRequest(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: auth.clientId, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || `Token request failed (${res.status})`);
  return json;
}

const auth = {
  refreshing: null,
  get clientId() { return store.get(LS.clientId, ''); },
  get tokens() { return store.get(LS.tokens); },
  get connected() { return Boolean(this.tokens?.refresh_token); },

  async login(clientId) {
    store.set(LS.clientId, clientId);
    const verifier = randomString(64);
    store.set(LS.verifier, verifier);
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPES.join(' '),
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: await pkceChallenge(verifier),
    });
    if (MOBILE) localStorage.setItem('msc.returnTo', '/mobile');
    location.href = `https://accounts.spotify.com/authorize?${query}`;
  },

  async handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return;
    history.replaceState(null, '', location.pathname);
    if (q.has('error')) throw new Error(`Spotify-Login fehlgeschlagen: ${q.get('error')}`);
    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code: q.get('code'),
      redirect_uri: REDIRECT_URI,
      code_verifier: store.get(LS.verifier),
    });
    store.del(LS.verifier);
    this.save(tokens);
  },

  save(t) {
    store.set(LS.tokens, {
      access_token: t.access_token,
      refresh_token: t.refresh_token || this.tokens?.refresh_token,
      expires_at: Date.now() + t.expires_in * 1000,
    });
  },

  async accessToken() {
    if (!this.tokens) throw new Error('Nicht mit Spotify verbunden.');
    if (Date.now() > this.tokens.expires_at - 60_000) await this.refresh();
    return this.tokens.access_token;
  },

  refresh() {
    this.refreshing ||= (async () => {
      try {
        this.save(await tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token }));
      } catch (err) {
        store.del(LS.tokens);
        throw new Error(`Spotify-Sitzung abgelaufen, bitte neu verbinden (${err.message}).`);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  },

  logout() { store.del(LS.tokens); },
};

async function api(pathOrUrl, { method = 'GET', body, retry = true, attempt = 0 } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await auth.accessToken()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // Spotify occasionally never answers a request; without a limit that froze the loading screen.
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name !== 'TimeoutError') throw err;
    const again = attempt < API_TIMEOUT_RETRIES;
    debugLog('spotify request timed out:', method, url.replace(API, '').split('?')[0], again ? `— retry ${attempt + 1}` : '— giving up');
    if (again) return api(pathOrUrl, { method, body, retry, attempt: attempt + 1 });
    throw new Error('Spotify antwortet nicht (Zeitüberschreitung). Versuch es nochmal.');
  }
  if (res.status === 401 && retry) {
    await auth.refresh();
    return api(pathOrUrl, { method, body, retry: false });
  }
  if (res.status === 429) {
    // Spotify throttles busy accounts. Short waits are sat out; long ones would look like a frozen game.
    const wait = Number(res.headers.get('Retry-After')) || 2;
    debugLog('spotify rate limit:', method, url.replace(API, '').split('?')[0], `retry after ${wait}s`);
    if (retry && wait <= MAX_RATE_LIMIT_WAIT_S) {
      await sleep(wait * 1000);
      return api(pathOrUrl, { method, body, retry: false });
    }
    const err = new Error(`Spotify bremst gerade (zu viele Anfragen). Versuch es in ${wait > 120 ? `${Math.ceil(wait / 60)} Minuten` : `${wait} Sekunden`} nochmal.`);
    err.status = 429;
    throw err;
  }
  if (res.status >= 500 && attempt < API_TIMEOUT_RETRIES) {
    // Spotify's servers hiccup now and then (503); a second try a moment later usually works.
    debugLog('spotify server error:', res.status, method, url.replace(API, '').split('?')[0], `— retry ${attempt + 1}`);
    await sleep(1000 * (attempt + 1));
    return api(pathOrUrl, { method, body, retry, attempt: attempt + 1 });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const json = JSON.parse(body);
      message = json.error?.message || json.error_description || message;
    } catch {
      if (body.trim()) message = body.trim().slice(0, 200); // Spotify sometimes answers in plain text
    }
    const err = new Error(message);
    err.status = res.status;
    // Development Mode apps only serve the owner and accounts listed under User Management.
    if (res.status === 403 && /not be registered|developer\.spotify\.com|user not registered/i.test(message)) {
      err.notRegistered = true;
      err.message = NOT_REGISTERED;
    }
    throw err;
  }
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null; // player commands sometimes answer 200 with a non-JSON body
  }
}

// ====================================================================== playlists

// Spotify links (22-character ids) and Deezer links (numeric ids, or link.deezer.com short links).
function parseSources(text) {
  const sources = [];
  const invalid = [];
  for (const token of text.split(/\s+/)) {
    if (!token) continue;
    const spotify = token.match(/(playlist|album)[/:]([A-Za-z0-9]{22})/);
    const deezer = token.match(/deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(playlist|album)\/(\d+)/i);
    const short = /^https?:\/\/(link\.deezer\.com|deezer\.page\.link)\//i.test(token);
    const src = spotify ? { service: 'spotify', type: spotify[1], id: spotify[2] }
      : deezer ? { service: 'deezer', type: deezer[1].toLowerCase(), id: deezer[2] }
        : short ? { service: 'deezer', short: token, id: token } : null;
    if (!src) invalid.push(token);
    else if (!sources.some((x) => x.id === src.id)) sources.push(src);
  }
  return { sources, invalid };
}

// Strip "- Remastered 2011", "(feat. X)", "(Radio Edit)" etc. so the big answer is just the song name.
function cleanTitle(name) {
  const cleaned = name
    .replace(/\s+[-–—]\s+.*\b(remaster(ed)?|version|edit|mix|live|mono|stereo|radio|single|original|acoustic|instrumental|from|recorded|anniversary|deluxe|bonus)\b.*$/i, '')
    .replace(/\s*[([][^)\]]*\b(feat\.?|ft\.?|with|remaster(ed)?|version|edit|mix|live|radio|single|original|from)\b[^)\]]*[)\]]/gi, '')
    .trim();
  return cleaned || name;
}

function toTrack(t, source) {
  if (!t || t.type !== 'track' || t.is_local || t.is_playable === false || !t.uri?.startsWith('spotify:track:')) return null;
  const images = [...(t.album?.images || [])].sort((a, b) => (b.width || 0) - (a.width || 0));
  return {
    uri: t.uri,
    id: t.id,
    name: t.name,
    title: cleanTitle(t.name),
    artists: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name || '',
    year: (t.album?.release_date || '').slice(0, 4),
    image: images[0]?.url || '',
    durationMs: t.duration_ms || 0,
    source,
  };
}

async function fetchPlaylist(id, onProgress = () => {}) {
  const meta = await api(`/playlists/${id}?fields=name,snapshot_id`).catch(() => null);
  const name = meta?.name || 'Playlist';

  // Newer API versions serve playlist contents at /items, older ones at /tracks — try both.
  // market=from_token marks songs that can't play in your country (is_playable: false).
  let page = null;
  let lastErr;
  for (const endpoint of ['items', 'tracks']) {
    try {
      page = await api(`/playlists/${id}/${endpoint}?limit=50&market=from_token`);
      break;
    } catch (err) {
      lastErr = err;
      if (err.status !== 403 && err.status !== 404 && !(err.status >= 500)) throw err;
    }
  }
  if (!page) {
    // Development Mode apps may only read playlists you own or collaborate on; fall back to the public embed.
    debugLog('playlist', id, 'refused by API:', lastErr.status, lastErr.message, '— trying public embed');
    try {
      return { ...(await fetchEmbedPlaylist(id)), snapshot: meta?.snapshot_id };
    } catch (err) {
      throw new Error(`Spotify gibt diese Playlist nicht frei (${lastErr.status}: ${lastErr.message}) und die öffentliche Seite ` +
        `war auch nicht lesbar (${err.message}). Ist sie privat? Tipp: Kopier die Songs in eine eigene Playlist.`);
    }
  }

  // The first page tells us the total: fetch the remaining pages in parallel instead of one after another.
  const pages = [page];
  const total = page.total ?? 0;
  const size = page.limit || 50;
  if (page.next && total > size) {
    const base = new URL(page.next);
    const offsets = [];
    for (let offset = size; offset < total; offset += size) offsets.push(offset);
    let loaded = page.items?.length || 0;
    onProgress(loaded);
    const rest = await mapLimit(offsets, 4, async (offset) => {
      base.searchParams.set('offset', offset);
      base.searchParams.set('limit', size);
      const p = await api(base.toString());
      loaded += p?.items?.length || 0;
      onProgress(loaded);
      return p;
    });
    pages.push(...rest);
  } else if (page.next) {
    // No total given: fall back to following the "next" links.
    for (let p = page; p.next;) {
      p = await api(p.next);
      pages.push(p);
    }
  }
  const tracks = [];
  for (const p of pages) {
    for (const item of p?.items || []) {
      const t = toTrack(item?.item ?? item?.track, name);
      if (t) tracks.push(t);
    }
  }
  return { name, tracks, snapshot: meta?.snapshot_id };
}

// Like Promise.all(items.map(fn)), but at most `limit` at a time (keeps Spotify's rate limits happy).
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Loaded playlists are remembered for a few hours: rematches and reloads start without asking Spotify again.
// Playlists read through the API carry Spotify's snapshot_id, which changes with every edit; one cheap
// request tells us whether songs were added or removed since, and if so the playlist is loaded fresh.
const SOURCE_CACHE_MS = 6 * 3600_000;
// Returns { data, current }; an outdated copy is still handed out as a fallback for when Spotify is down.
async function cachedSource(src) {
  const hit = store.get(`msc.source.${src.type}.${src.id}`);
  if (!hit) return null;
  if (Date.now() - hit.at >= SOURCE_CACHE_MS) return { data: hit.data, current: false };
  if (src.type !== 'playlist') return { data: hit.data, current: true };
  const now = await api(`/playlists/${src.id}?fields=snapshot_id`).catch(() => null);
  return { data: hit.data, current: !now?.snapshot_id || now.snapshot_id === hit.data.snapshot };
}
// Shown on the setup screen as buttons, so a playlist doesn't have to be pasted again.
const RECENT_MAX = 8;
function recentSources() {
  const saved = store.get(LS.recent, null);
  if (saved) return saved;
  // Before this list existed, played sources were only in the cache: start from those.
  return Object.keys(localStorage)
    .filter((key) => key.startsWith('msc.source.'))
    .map((key) => {
      const [, , type, id] = key.split('.');
      const hit = store.get(key);
      return hit?.data && { type, id, name: hit.data.name, count: hit.data.tracks.length, at: hit.at };
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_MAX);
}
function rememberSource(src, data) {
  const list = recentSources().filter((r) => r.id !== src.id);
  list.unshift({ service: src.service || 'spotify', type: src.type, id: src.id, name: data.name, count: data.tracks.length, at: Date.now() });
  store.set(LS.recent, list.slice(0, RECENT_MAX));
}

function cacheSource(src, data, key = `msc.source.${src.type}.${src.id}`) {
  try {
    store.set(key, { at: Date.now(), data });
  } catch {
    // Storage full: drop old entries and carry on without caching.
    for (const key of Object.keys(localStorage)) if (/^msc\.(dz)?source\./.test(key)) localStorage.removeItem(key);
  }
}

// Public playlists owned by someone else, read from Spotify's embed page via server.js (max 100 songs).
// Covers and album names are filled in from the player once a song plays (see syncToPlayer).
async function fetchEmbedPlaylist(id, type = 'playlist') {
  const res = await fetch(`/embed/${type}/${id}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  const tracks = data.tracks.filter((t) => t.playable).map((t) => ({
    uri: t.uri,
    id: t.uri.split(':')[2],
    name: t.name,
    title: cleanTitle(t.name),
    artists: t.artists,
    album: '',
    year: '',
    image: '',
    durationMs: t.durationMs,
    source: data.name,
  }));
  return { name: data.name, tracks, note: `öffentliche Seite${data.tracks.length >= 100 ? ', nur die ersten 100' : ''}` };
}

async function fetchAlbum(id) {
  const album = await api(`/albums/${id}`);
  const tracks = [];
  let page = album.tracks;
  while (page) {
    for (const t of page.items || []) {
      const track = toTrack({ ...t, album }, album.name);
      if (track) tracks.push(track);
    }
    page = page.next ? await api(page.next) : null;
  }
  return { name: album.name, tracks };
}

function dedupe(tracks) {
  const seen = new Set();
  return tracks.filter((t) => {
    const keys = [t.uri, `${t.title.toLowerCase()}|${t.artists.split(',')[0].toLowerCase()}`];
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
}

// ====================================================================== Spotify player (Web Playback SDK)

const spotify = {
  player: null,
  pollMs: 120, // how often nextRound checks whether the song started
  deviceId: null,
  ready: null,

  init() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const fail = (message) => {
        toast(message, 'error', 9000);
        reject(new Error(message));
      };
      window.onSpotifyWebPlaybackSDKReady = () => {
        const player = new Spotify.Player({
          name: 'Pogo & Polonaise',
          getOAuthToken: (cb) => auth.accessToken().then(cb).catch((e) => toast(e.message, 'error')),
          volume: store.get(LS.volume, 0.8),
        });
        player.addListener('ready', ({ device_id }) => {
          debugLog('spotify player ready');
          this.deviceId = device_id;
          resolve(device_id);
        });
        player.addListener('not_ready', () => {
          debugLog('spotify player offline');
          this.deviceId = null;
          if (ui.screen === 'game') toast('Spotify-Player offline – verbinde neu…', 'error');
        });
        player.addListener('initialization_error', ({ message }) => fail(`Dieser Browser kann den Spotify-Player nicht starten (${message}). Nimm Chrome, Edge oder Firefox.`));
        player.addListener('authentication_error', ({ message }) => fail(`Spotify-Anmeldung fehlgeschlagen (${message}). Trennen und neu verbinden.`));
        player.addListener('account_error', () => fail('Zum Abspielen im Browser brauchst du Spotify Premium.'));
        player.addListener('playback_error', ({ message }) => onPlaybackError(message));
        player.addListener('player_state_changed', onPlayerState);
        player.connect();
        this.player = player;
      };
      const script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.onerror = () => fail('Spotify-Player konnte nicht geladen werden. Bist du online?');
      document.head.append(script);
    });
    this.ready.catch(() => {}); // surfaced via toast; callers await it again where it matters
    return this.ready;
  },

  async transfer() {
    try {
      await api('/me/player', { method: 'PUT', body: { device_ids: [this.deviceId], play: false } });
    } catch { /* not fatal: play() targets the device explicitly */ }
  },

  async play(uris, positionMs) {
    const body = { uris, offset: { position: 0 }, position_ms: positionMs };
    try {
      await api(`/me/player/play?device_id=${this.deviceId}`, { method: 'PUT', body });
    } catch (err) {
      if (err.status !== 404 && err.status !== 502) throw err;
      await this.transfer();
      await sleep(700);
      await api(`/me/player/play?device_id=${this.deviceId}`, { method: 'PUT', body });
    }
  },

  state() { return this.player ? this.player.getCurrentState().catch(() => null) : Promise.resolve(null); },

  // Start tracks[index] with its own play request. Skipping to a queued song (via the SDK or the Web API)
  // proved unreliable — Spotify moves to the song but leaves it paused with "The operation is not allowed".
  // One URI per request also means Spotify stops when a song ends instead of starting the next one early,
  // and the user's shuffle setting doesn't matter.
  async playFrom(tracks, index, positionMs) {
    debugLog('round', index + 1, 'play', tracks[index].name);
    await this.play([tracks[index].uri], positionMs);
  },

  pause() { return this.player ? this.player.pause().catch(() => {}) : Promise.resolve(); },
  resume() { return this.player?.resume().catch(() => {}); },

  level: store.get(LS.volume, 0.8), // volume currently applied to the player
  fadeId: 0,
  get userVolume() { return store.get(LS.volume, 0.8); },
  setVolume(v) {
    this.level = v;
    return this.player?.setVolume(v).catch(() => {});
  },
  // Linear volume ramp; starting a new fade cancels the running one.
  async fade(to, ms) {
    const id = ++this.fadeId;
    const from = this.level;
    const steps = Math.max(1, Math.round(ms / 40));
    for (let i = 1; i <= steps; i++) {
      if (id !== this.fadeId) return;
      await this.setVolume(from + (to - from) * (i / steps));
      await sleep(ms / steps);
    }
  },

  disconnect() {
    this.player?.disconnect();
    this.player = null;
    this.deviceId = null;
    this.ready = null;
  },
};

// Phone version: remote-control a Spotify Connect device through the Web API instead of the in-browser
// player. There are no state events from a remote device, so state is polled (gently — API rate limits),
// and fades only keep their timing: phones don't allow remote volume changes.
if (MOBILE) {
  Object.assign(spotify, {
    pollMs: 700,
    init() {
      return this.deviceId ? Promise.resolve(this.deviceId) : Promise.reject(new Error('Wähl aus, wo die Musik läuft (Schritt 1).'));
    },
    async state() {
      const p = await api('/me/player').catch(() => null);
      if (!p?.item) return null;
      return { paused: !p.is_playing, loading: false, position: p.progress_ms ?? 0, duration: p.item.duration_ms, track_window: { current_track: p.item } };
    },
    // 403 here means "already paused/playing" — harmless.
    pause() {
      return api(`/me/player/pause?device_id=${this.deviceId}`, { method: 'PUT' }).catch((e) => e.status !== 403 && debugLog('pause failed:', e.message));
    },
    resume() {
      return api(`/me/player/play?device_id=${this.deviceId}`, { method: 'PUT' }).catch((e) => e.status !== 403 && debugLog('resume failed:', e.message));
    },
    // Remote volume works on some Spotify devices (speakers, computers) but not on phones (supports_volume).
    canVolume: false,
    deviceVolume: 0.8,
    async setVolume(v) {
      this.level = v;
      if (!this.canVolume) return;
      await api(`/me/player/volume?volume_percent=${Math.round(v * 100)}&device_id=${this.deviceId}`, { method: 'PUT' })
        .catch((e) => debugLog('volume failed:', e.message));
    },
    async fade(to, ms) {
      const id = ++this.fadeId;
      if (!this.canVolume) {
        await sleep(ms);
        if (id === this.fadeId) this.level = to;
        return;
      }
      const from = this.level;
      const steps = Math.max(1, Math.min(4, Math.round(ms / 400))); // few steps: every step is an API call
      for (let i = 1; i <= steps; i++) {
        if (id !== this.fadeId) return;
        await this.setVolume(from + (to - from) * (i / steps));
        await sleep(ms / steps);
      }
    },
    disconnect() { this.deviceId = null; },
  });
  // The user's volume is whatever the Spotify device is set to (Object.assign can't replace a getter).
  Object.defineProperty(spotify, 'userVolume', { get() { return this.deviceVolume; } });
}

function useDevice(id) {
  const d = (spotify.devices || []).find((x) => x.id === id);
  spotify.canVolume = Boolean(d?.supports_volume);
  spotify.deviceVolume = d?.volume_percent != null ? Math.max(0.2, d.volume_percent / 100) : 0.8;
  spotify.level = spotify.deviceVolume;
}

async function loadDevices() {
  if (!MOBILE || !auth.connected) return;
  $('#devices').hidden = false;
  const list = $('#device-list');
  try {
    const devices = ((await api('/me/player/devices'))?.devices || []).filter((d) => d.id && !d.is_restricted);
    const saved = store.get(LS.device, null);
    if (!devices.some((d) => d.id === spotify.deviceId)) {
      const pick = devices.find((d) => d.id === saved) || devices.find((d) => d.is_active)
        || devices.find((d) => d.type === 'Smartphone') || devices[0];
      spotify.deviceId = pick?.id || null;
    }
    if (spotify.deviceId) store.set(LS.device, spotify.deviceId);
    spotify.devices = devices;
    useDevice(spotify.deviceId);
    debugLog('devices:', devices.map((d) => `${d.name} (${d.type})`).join(', ') || 'none');
    list.innerHTML = devices.length
      ? devices.map((d) => `<label class="device"><input type="radio" name="device" value="${esc(d.id)}"${d.id === spotify.deviceId ? ' checked' : ''}>
          <span><b>${esc(d.name)}</b> <small>${esc(d.type)}${d.is_active ? ' · aktiv' : ''}</small></span></label>`).join('')
      : '<p class="hint">Kein Spotify-Gerät gefunden. Öffne die <b>Spotify-App</b> auf diesem Handy (oder schalt die Box ein), spiel kurz irgendeinen Song und tipp auf Aktualisieren.</p>';
  } catch (err) {
    list.innerHTML = `<p class="hint">Spotify-Geräte konnten nicht geladen werden: ${esc(err.message)}</p>`;
  }
}

// ====================================================================== Deezer (the default music source)

// Deezer gives everyone 30-second previews without a login. They are plain MP3s the browser may load (CORS), so
// they play through Web Audio: exact starts, fades that also work on phones, and a real crossfade — the next song
// starts while the old one is still fading out. The server (deezer.js) supplies playlists and fresh preview links.
const DEEZER_MAX_LIMIT = 25; // seconds per round: the previews are 30 s long
const XFADE_MS = 4000; // Deezer crossfade: both songs audible for this long
const FIRST_FADE_MS = 1200; // fade-in of the very first song (nothing to blend with)

// Equal-power fade: one song goes down along a cosine while the other comes up along a sine, so the overall
// loudness stays even. (An exponential fade-out drops the old song almost at once and sounds like a cut.)
// Built from short linear steps rather than setValueCurveAtTime, which throws when it overlaps another curve.
function equalPowerRamp(param, ctx, from, to, ms, direction) {
  const now = ctx.currentTime;
  const steps = 32;
  param.cancelScheduledValues(now);
  param.setValueAtTime(Math.max(from, 0.0001), now);
  for (let i = 1; i <= steps; i++) {
    const x = i / steps;
    const k = direction === 'in' ? Math.sin((x * Math.PI) / 2) : Math.cos((x * Math.PI) / 2);
    const v = direction === 'in' ? from + (to - from) * k : to + (from - to) * k;
    param.linearRampToValueAtTime(Math.max(v, 0.0001), now + (x * ms) / 1000);
  }
}
const deezerPlayer = {
  crossfade: true, // nextRound lets songs overlap instead of riser + drop; playFrom also does the fade-in
  crossfadeMs: XFADE_MS,
  pollMs: 100,
  level: store.get(LS.volume, 0.8),
  fadeId: 0,
  current: null, // { track, buffer, source, gain, startedAt, offset, paused, ended }
  tails: new Set(), // songs still fading out
  buffers: new Map(), // track id -> Promise<AudioBuffer>
  get userVolume() { return store.get(LS.volume, 0.8); },
  get ctx() {
    sfx.init();
    return sfx.ctx;
  },
  init() { return Promise.resolve(); },
  transfer() { return Promise.resolve(); },

  load(t) {
    if (!this.buffers.has(t.id)) {
      const loading = (async () => {
        const res = await fetch(`/api/deezer/track/${t.id}`);
        if (!res.ok) throw new Error(`Deezer HTTP ${res.status}`);
        const { preview } = await res.json();
        if (!preview) throw new Error('kein Ausschnitt verfügbar');
        const audio = await fetch(preview, { signal: AbortSignal.timeout(15_000) });
        if (!audio.ok) throw new Error(`Ausschnitt HTTP ${audio.status}`);
        return this.ctx.decodeAudioData(await audio.arrayBuffer());
      })();
      loading.catch(() => this.buffers.delete(t.id));
      this.buffers.set(t.id, loading);
      if (this.buffers.size > 6) this.buffers.delete(this.buffers.keys().next().value);
    }
    return this.buffers.get(t.id);
  },

  async playFrom(tracks, index, positionMs) {
    const t = tracks[index];
    const buffer = await withTimeout(this.load(t), 20_000, 'der Ausschnitt lädt nicht');
    const blending = Boolean(this.current?.source);
    if (blending) this.retire(this.current, XFADE_MS); // the old song fades out while this one fades in
    this.current = { track: t, buffer, offset: Math.min(positionMs / 1000, Math.max(0, buffer.duration - 1)), paused: true };
    this.level = 0;
    this.start(this.current);
    this.fadeId++;
    this.level = this.userVolume; // where the fade-in ends (pause/resume continue from there)
    equalPowerRamp(this.current.gain.gain, this.ctx, 0, this.level, blending ? XFADE_MS : FIRST_FADE_MS, 'in');
    const next = tracks[index + 1];
    if (next) this.load(next).catch(() => {}); // ready before anyone presses "next"
  },

  start(c) {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(this.level, 0.0001), ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = c.buffer;
    src.connect(gain).connect(ctx.destination);
    src.onended = () => {
      if (c.source !== src) return;
      Object.assign(c, { source: null, offset: c.buffer.duration, paused: true, ended: true });
    };
    src.start(0, c.offset);
    Object.assign(c, { source: src, gain, startedAt: ctx.currentTime - c.offset, paused: false, ended: false });
  },

  retire(c, ms) {
    if (!c.source) return;
    const ctx = this.ctx;
    const g = c.gain.gain;
    const src = c.source;
    equalPowerRamp(g, ctx, g.value, 0, ms, 'out');
    src.stop(ctx.currentTime + ms / 1000 + 0.05);
    this.tails.add(src);
    src.addEventListener('ended', () => this.tails.delete(src));
    c.source = null;
  },

  position(c = this.current) {
    if (!c) return 0;
    return c.paused ? c.offset : this.ctx.currentTime - c.startedAt;
  },
  remainingMs() {
    const c = this.current;
    return c && !c.paused ? (c.buffer.duration - this.position(c)) * 1000 : Infinity;
  },

  async state() {
    const c = this.current;
    if (!c) return null;
    const t = c.track;
    return {
      paused: c.paused,
      loading: false,
      position: this.position(c) * 1000,
      duration: c.buffer.duration * 1000,
      track_window: { current_track: { uri: t.uri, id: t.id, name: t.name, artists: [{ name: t.artists }], album: { name: t.album, images: t.image ? [{ url: t.image, width: 1000 }] : [] } } },
    };
  },

  pause() {
    for (const tail of this.tails) tail.stop(); // a buzz silences a crossfade too
    this.tails.clear();
    const c = this.current;
    if (c && !c.paused) {
      c.offset = this.position(c);
      c.paused = true;
      const src = c.source;
      c.source = null;
      src?.stop();
    }
    return Promise.resolve();
  },
  resume() {
    const c = this.current;
    if (c && c.paused && !c.ended) this.start(c);
    return Promise.resolve();
  },
  setVolume(v) {
    this.level = v;
    const g = this.current?.gain?.gain;
    if (g) {
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setValueAtTime(Math.max(v, 0.0001), this.ctx.currentTime);
    }
    return Promise.resolve();
  },
  async fade(to, ms) {
    const id = ++this.fadeId;
    const g = this.current?.gain?.gain;
    if (g) {
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(Math.max(g.value, 0.0001), now);
      g.linearRampToValueAtTime(Math.max(to, 0.0001), now + ms / 1000);
    }
    await sleep(ms);
    if (id === this.fadeId) this.level = to;
  },
  disconnect() {
    this.pause();
    this.current = null;
  },
};

// The music source of the running game: deezerPlayer or spotify (both offer the same methods).
let music = spotify;

const deezerTrack = (t, source) => ({
  uri: `deezer:track:${t.id}`,
  id: t.id,
  name: t.name,
  title: cleanTitle(t.title || t.name),
  artists: t.artists,
  album: t.album || '',
  year: '',
  image: t.image || '',
  durationMs: 30_000, // the preview, not the song
  source,
});

async function deezerApi(path, body) {
  const res = await fetch(`/api/deezer/${path}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error('zu viele Anfragen – warte kurz');
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Load a source for a Deezer game. Spotify links work too: their songs are looked up on Deezer — the full list if
// Spotify is connected, otherwise the first 100 from the playlist's public page.
async function loadForDeezer(src, progress) {
  if (src.mix?.file) { // ships with the game
    const res = await fetch(`/${src.mix.file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { name: src.mix.name, tracks: data.tracks.map((t) => deezerTrack(t, src.mix.name)) };
  }
  if (src.mix) {
    const data = await deezerApi(`playlist/${src.mix.deezer}`);
    return { name: src.mix.name, tracks: data.tracks.map((t) => deezerTrack(t, src.mix.name)) };
  }
  if (src.service === 'deezer') {
    const data = await deezerApi(`${src.type}/${src.id}`);
    return { name: data.name, tracks: data.tracks.map((t) => deezerTrack(t, data.name)) };
  }
  const list = auth.connected
    ? await (src.type === 'album' ? fetchAlbum(src.id) : fetchPlaylist(src.id, (n) => progress(`Lade Spotify-Playlist… ${n} Songs`)))
    : await fetchEmbedPlaylist(src.id, src.type);
  const found = [];
  for (let i = 0; i < list.tracks.length; i += 100) {
    progress(`Suche Songs auf Deezer… ${i} / ${list.tracks.length}`);
    const chunk = list.tracks.slice(i, i + 100).map((t) => ({ name: t.name, artists: t.artists }));
    const { matches } = await deezerApi('match', { tracks: chunk });
    found.push(...matches.filter(Boolean));
  }
  const note = `${found.length} von ${list.tracks.length} auf Deezer gefunden${!auth.connected && list.tracks.length >= 100 ? ', nur die ersten 100' : ''}`;
  return { name: list.name, tracks: found.map((t) => deezerTrack(t, list.name)), note };
}

// ====================================================================== sound effects

const sfx = {
  ctx: null,
  init() {
    try {
      this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
      this.ctx.resume();
    } catch { /* no audio, no problem */ }
  },
  note(freq, at = 0, dur = 0.15, type = 'triangle', vol = 0.25, slideTo) {
    const c = this.ctx;
    if (!c) return;
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  },
  buzz(i) {
    const base = i === 0 ? 660 : 494;
    this.note(base, 0, 0.12, 'square', 0.16);
    this.note(base * 1.5, 0.1, 0.28, 'square', 0.16);
  },
  pass() { this.note(330, 0, 0.12, 'sine', 0.2); this.note(262, 0.1, 0.18, 'sine', 0.2); },
  correct() { [523, 659, 784, 1047].forEach((f, k) => this.note(f, k * 0.09, 0.24, 'triangle', 0.28)); },
  wrong() { this.note(220, 0, 0.5, 'sawtooth', 0.18, 80); },
  timeout() { [392, 330, 262].forEach((f, k) => this.note(f, k * 0.2, k === 2 ? 0.5 : 0.2, 'triangle', 0.25)); },
  beep(f) { this.note(f, 0, 0.2, 'sine', 0.3); },
  fanfare() {
    [[523, 0, 0.15], [659, 0.15, 0.15], [784, 0.3, 0.15], [1047, 0.45, 0.3], [784, 0.8, 0.15], [1047, 0.95, 0.6]]
      .forEach(([f, at, d]) => this.note(f, at, d, 'triangle', 0.3));
  },

  noise: null,
  noiseBuffer() {
    if (!this.noise) {
      const length = this.ctx.sampleRate * 3;
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  },
  // DJ transition, part 1: a filtered-noise sweep that rises while the old song fades down.
  riser(seconds) {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const t0 = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuffer();
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 5;
    filter.frequency.setValueAtTime(250, t0);
    filter.frequency.exponentialRampToValueAtTime(7000, t0 + seconds);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.32, t0 + seconds);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds + 0.12);
    src.connect(filter).connect(gain).connect(c.destination);
    src.start(t0);
    src.stop(t0 + seconds + 0.15);
  },
  // Part 2: a bass drop and a falling whoosh that cover the moment Spotify switches to the new song.
  drop() {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const t0 = c.currentTime;
    const boom = c.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(110, t0);
    boom.frequency.exponentialRampToValueAtTime(36, t0 + 0.8);
    const boomGain = c.createGain();
    boomGain.gain.setValueAtTime(0.0001, t0);
    boomGain.gain.exponentialRampToValueAtTime(0.6, t0 + 0.02);
    boomGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2);
    boom.connect(boomGain).connect(c.destination);
    boom.start(t0);
    boom.stop(t0 + 1.3);
    const whoosh = c.createBufferSource();
    whoosh.buffer = this.noiseBuffer();
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 3;
    filter.frequency.setValueAtTime(6000, t0);
    filter.frequency.exponentialRampToValueAtTime(180, t0 + 2.2);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.28, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.2);
    whoosh.connect(filter).connect(gain).connect(c.destination);
    whoosh.start(t0);
    whoosh.stop(t0 + 2.3);
  },
};

// ====================================================================== main-menu music

// The instrumental intro of "Das geht ab" (Die Atzen): 4 bars cut on the beat, so it loops seamlessly through
// Web Audio (an <audio loop> would stutter). Browsers only allow sound after a tap, so it starts on the first
// interaction with the setup screen and stops as soon as the game begins.
const menuMusic = {
  wanted: store.get(LS.menuMusic, true),
  buffer: null,
  loading: null,
  source: null,
  gain: null,

  get volume() { return Math.min(1, music.userVolume) * 0.5; },

  async start() {
    if (!this.wanted || this.source || ui.screen !== 'setup') return;
    sfx.init();
    const c = sfx.ctx;
    if (!c) return;
    if (c.state !== 'running') await c.resume().catch(() => {});
    if (c.state !== 'running') return; // no tap yet
    try {
      this.loading ||= fetch('audio/menu-loop.wav').then((r) => r.arrayBuffer()).then((b) => c.decodeAudioData(b));
      this.buffer = await this.loading;
    } catch (err) {
      debugLog('menu music failed:', err.message);
      return;
    }
    if (this.source || !this.wanted || ui.screen !== 'setup') return;
    const src = c.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(this.volume, c.currentTime + 1.2);
    src.connect(gain).connect(c.destination);
    src.start();
    this.source = src;
    this.gain = gain;
    renderMenuMusic();
  },

  stop(ms = 700) {
    const { source, gain } = this;
    if (!source) return;
    const c = sfx.ctx;
    gain.gain.cancelScheduledValues(c.currentTime);
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + ms / 1000);
    source.stop(c.currentTime + ms / 1000 + 0.05);
    this.source = null;
    this.gain = null;
    renderMenuMusic();
  },

  setVolume() {
    if (this.gain) this.gain.gain.setTargetAtTime(Math.max(this.volume, 0.0001), sfx.ctx.currentTime, 0.1);
  },

  toggle() {
    this.wanted = !this.wanted;
    store.set(LS.menuMusic, this.wanted);
    if (this.wanted) this.start();
    else this.stop();
    renderMenuMusic();
  },
};

function renderMenuMusic() {
  const btn = $('#menu-music');
  btn.textContent = menuMusic.wanted ? (menuMusic.source ? 'Musik aus' : 'Musik an – tipp irgendwo') : 'Musik an';
  btn.classList.toggle('off', !menuMusic.wanted);
}

// ====================================================================== confetti

const confetti = (() => {
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  let parts = [];
  let raf = null;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resize);
  resize();

  function frame() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.32;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      // Flat paper bits with a black outline, plus the odd sparkle (sequin) — brand colours only.
      ctx.fillStyle = p.color;
      ctx.strokeStyle = '#141414';
      ctx.lineWidth = 1.5;
      if (p.sparkle) {
        const r = p.size;
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.quadraticCurveTo(r * 0.12, -r * 0.12, r, 0);
        ctx.quadraticCurveTo(r * 0.12, r * 0.12, 0, r);
        ctx.quadraticCurveTo(-r * 0.12, r * 0.12, -r, 0);
        ctx.quadraticCurveTo(-r * 0.12, -r * 0.12, 0, -r);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.strokeRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      }
      ctx.restore();
    }
    parts = parts.filter((p) => p.y < innerHeight + 60);
    raf = parts.length ? requestAnimationFrame(frame) : null;
  }

  return {
    burst(originEl, colors, count = 140) {
      const r = originEl?.getBoundingClientRect();
      const ox = r ? r.left + r.width / 2 : innerWidth / 2;
      const oy = r ? r.top + r.height / 3 : innerHeight / 2;
      for (let i = 0; i < count; i++) {
        parts.push({
          x: ox + (Math.random() - 0.5) * 120,
          y: oy,
          vx: (Math.random() - 0.5) * 18,
          vy: -Math.random() * 15 - 5,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.3,
          size: 8 + Math.random() * 8,
          color: colors[i % colors.length],
          sparkle: Math.random() < 0.12,
        });
      }
      raf ||= requestAnimationFrame(frame);
    },
  };
})();

// ====================================================================== UI helpers

const ui = { screen: 'setup', actionsKey: null };

function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== `screen-${name}`;
  ui.screen = name;
  if (name === 'setup') {
    menuMusic.start();
    renderRecent();
  } else menuMusic.stop();
  phones.push();
  renderPhones();
  document.activeElement?.blur();
}

function toast(message, kind = 'info', ms = 4500) {
  if (kind === 'error') errorLog('toast:', message);
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, ms);
}

function flash(i) {
  const el = $('#flash');
  el.style.background = i === 0 ? 'var(--p1)' : 'var(--p2)';
  el.classList.remove('go');
  void el.offsetWidth;
  el.classList.add('go');
}

async function countdown() {
  const overlay = $('#overlay');
  overlay.hidden = false;
  for (const text of ['3', '2', '1', 'Los!']) {
    overlay.innerHTML = `<span>${text}</span>`;
    sfx.beep(text.length > 1 ? 880 : 440);
    await sleep(text.length > 1 ? 900 : 750);
  }
  overlay.hidden = true;
}

// Brand palette only: pink, yellow, black, white (player 1 leads with pink, player 2 with black).
const playerColors = (i) => (i === 0 ? ['#E8508A', '#F2E060', '#FFFFFF', '#141414'] : ['#141414', '#F2E060', '#FFFFFF', '#E8508A']);

// ====================================================================== phone controllers (hosted only)

// Each player gets a QR code; scanning it opens phone.html as that player's buzzer. Presses arrive over
// Server-Sent Events and go through the same buzz()/pass() as the A/L and S/K keys.
const phones = {
  session: null, // { id, hostKey, playerKeys }
  stream: null,
  counts: [0, 0],
  lastState: '',
  qrCache: new Map(),

  async connect() {
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(store.get(LS.phoneSession, {})), // resume, so scanned QR codes stay valid
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.session = await res.json();
      store.set(LS.phoneSession, this.session);
      debugLog('phone session ready', this.session.id.slice(0, 6));
    } catch (err) {
      debugLog('phone session failed:', err.message);
      setTimeout(() => this.connect(), 5000);
      return;
    }
    const { id, hostKey } = this.session;
    this.stream?.close();
    this.stream = new EventSource(`/api/session/${id}/host?key=${encodeURIComponent(hostKey)}`);
    this.stream.addEventListener('press', (e) => this.onPress(JSON.parse(e.data)));
    this.stream.addEventListener('phones', (e) => {
      const counts = JSON.parse(e.data);
      if (counts.join() !== this.counts.join()) debugLog('phones connected:', counts.join(' / '));
      this.counts = counts;
      renderPhones();
    });
    this.stream.onopen = () => this.push(true);
    this.stream.onerror = () => {
      // CLOSED: the server forgot the session (restart) — re-create it with the same id and keys.
      if (this.stream.readyState === EventSource.CLOSED) {
        debugLog('phone session lost — re-creating');
        setTimeout(() => this.connect(), 2000);
      }
    };
    renderPhones();
  },

  url(i) {
    const { id, playerKeys } = this.session;
    return `${location.origin}/phone.html?s=${id}&p=${i}&k=${playerKeys[i]}`;
  },

  qrSvg(i) {
    const url = this.url(i);
    if (!this.qrCache.has(url)) {
      const qr = qrcode(0, 'L');
      qr.addData(url);
      qr.make();
      this.qrCache.set(url, qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: 'QR code: buzz with your phone' }));
    }
    return this.qrCache.get(url);
  },

  // Also used by Bluetooth controllers (via 'gamepad'), which offer the same actions.
  onPress({ player, action }, via = 'phone') {
    if (ui.screen === 'game') {
      // Without a laptop the players run the game from their phones. Judging is done by the opponent of
      // whoever buzzed, so nobody approves their own answer.
      const judge_ = (fn) => {
        if (!canJudge(player)) return;
        debugLog('round', game.index + 1, action, `via ${via} of`, game.players[player].name);
        fn();
      };
      switch (action) {
        case 'buzz': buzz(player, via); break;
        case 'pass': pass(player, via); break;
        case 'show': judge_(showAnswer); break;
        case 'correct': judge_(() => judge(true)); break;
        case 'wrong': judge_(() => judge(false)); break;
        case 'next': game.phase === 'reveal' ? ready(player, via) : next(); break;
        default: break;
      }
    } else if (ui.screen === 'setup' && action === 'buzz') {
      // Lets players check their phone works before the game starts.
      sfx.buzz(player);
      const box = document.querySelector(`[data-phone-setup="${player}"]`);
      if (!box) return;
      box.classList.remove('tested');
      void box.offsetWidth;
      box.classList.add('tested');
    }
  },

  // Send the game state to the phones; unchanged states aren't re-sent.
  push(force = false) {
    if (!this.session) return;
    const state = phoneState();
    const json = JSON.stringify(state);
    if (!force && json === this.lastState) return;
    this.lastState = json;
    const { id, hostKey } = this.session;
    fetch(`/api/session/${id}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: hostKey, state }),
    }).then((res) => {
      if (res.status === 404) this.connect();
    }).catch(() => {});
  },
};

const canJudge = (i) => game.phase === 'answering' && game.buzzer !== null && game.buzzer !== i;
// "Don't know" only while the music plays: passing after the other player buzzed would just cut their points.
const canPass = (i) => game.phase === 'playing' && !game.players[i]?.out;

function phoneState() {
  const phase = ui.screen === 'over' ? 'over' : (ui.screen === 'game' && game.s ? shownPhase() : 'setup');
  const inGame = phase !== 'setup';
  const names = inGame ? game.players.map((p) => p.name) : readSettingsForm().names;
  const players = names.map((name, i) => ({
    name,
    score: inGame ? game.players[i].score : 0,
    out: ['playing', 'answering'].includes(phase) ? game.players[i].out : null,
  }));
  const t = currentTrack();
  const [a, b] = game.players;
  return {
    phase,
    players,
    target: inGame ? game.s.target : null,
    buzzer: phase === 'answering' ? game.buzzer : null,
    canBuzz: [0, 1].map((i) => phase === 'playing' && !players[i].out),
    canPass: [0, 1].map((i) => phase === 'playing' && canPass(i)),
    result: phase === 'reveal' ? game.result : null,
    // Shown on reveal, or once someone pressed "show song" while judging.
    answer: (phase === 'reveal' || (phase === 'answering' && game.answerShown)) && t ? { title: t.title, artists: t.artists, image: t.image } : null,
    answerShown: phase === 'answering' && game.answerShown,
    canJudge: [0, 1].map((i) => phase === 'answering' && canJudge(i)),
    canNext: [0, 1].map((i) => phase === 'reveal' && !game.ready[i]),
    ready: game.ready,
    winner: phase === 'over' ? (a.score === b.score ? -1 : a.score > b.score ? 0 : 1) : null,
    reducedFor: [0, 1].map((i) => ['playing', 'answering'].includes(phase) && opponentPassed(i)),
    factor: inGame ? factorLabel() : null,
  };
}

function renderPhones() {
  if (!phones.session) return;
  $('#phones-setup').hidden = false;
  const names = ui.screen === 'setup' || !game.players.length ? readSettingsForm().names : game.players.map((p) => p.name);
  [0, 1].forEach((i) => {
    const count = phones.counts[i];
    const status = count ? `${count > 1 ? `${count} Handys` : 'Handy'} verbunden` : 'Noch kein Handy';
    const box = document.querySelector(`[data-phone-setup="${i}"]`);
    box.querySelector('.qr').innerHTML = phones.qrSvg(i);
    box.querySelector('.pq-name').textContent = names[i];
    box.querySelector('.pq-status').textContent = status;
    box.classList.toggle('connected', count > 0);

    const panel = document.querySelector(`[data-phone="${i}"]`);
    panel.hidden = false;
    panel.querySelector('.qr').innerHTML = phones.qrSvg(i);
    panel.querySelector('.pq-status').textContent = count ? 'Handy verbunden' : 'Scannen zum Buzzern';
    panel.classList.toggle('connected', count > 0);
  });
}

// ====================================================================== settings / setup screen

function loadSettings() {
  const saved = store.get(LS.settings, {});
  // Older versions scored 1–3 points per song; reset the target to fit the 10-point scale.
  if (saved.version !== SETTINGS_VERSION) delete saved.target;
  // The Malle-era default team names give way to the Pogo & Polonaise ones (custom names stay).
  const oldDefaults = ['Team Sangria', 'Team Ensaïmada'];
  if (Array.isArray(saved.names)) saved.names = saved.names.map((n, i) => (n === oldDefaults[i] ? DEFAULT_SETTINGS.names[i] : n));
  return { ...DEFAULT_SETTINGS, ...saved };
}

function fillSettingsForm(s) {
  $('#playlists').value = s.playlists;
  $('#name1').value = s.names[0];
  $('#name2').value = s.names[1];
  $('#target').value = s.target;
  $('#limit').value = String(s.limit);
  $('#start-pos').value = s.startPos;
  $('#penalty').checked = s.penalty;
  $('#pass-factor').value = String(s.passFactor);
  for (const r of document.querySelectorAll('input[name=source]')) r.checked = r.value === s.source;
  setup.mixes = new Set(s.mixes);
  setup.customLinks = s.customLinks;
  renderMixes();
}

function readSettingsForm() {
  return {
    version: SETTINGS_VERSION,
    playlists: $('#playlists').value.trim(),
    names: [$('#name1').value.trim() || 'Spieler 1', $('#name2').value.trim() || 'Spieler 2'],
    target: Math.max(1, Math.min(500, Number($('#target').value) || DEFAULT_SETTINGS.target)),
    limit: Number($('#limit').value) || DEFAULT_SETTINGS.limit,
    startPos: $('#start-pos').value,
    penalty: $('#penalty').checked,
    passFactor: Number($('#pass-factor').value) || DEFAULT_SETTINGS.passFactor,
    source: document.querySelector('input[name=source]:checked')?.value || DEFAULT_SETTINGS.source,
    mixes: [...setup.mixes],
    customLinks: setup.customLinks,
  };
}

function renderRecent() {
  const recent = recentSources();
  const chosen = new Set(parseSources($('#playlists').value).sources.map((s) => s.id));
  $('#recent').hidden = !recent.length;
  $('#recent-list').replaceChildren(...recent.map((r) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn small ${chosen.has(r.id) ? 'on' : 'ghost'}`;
    b.dataset.type = r.type;
    b.dataset.service = r.service || 'spotify';
    b.dataset.id = r.id;
    b.setAttribute('aria-pressed', String(chosen.has(r.id)));
    b.textContent = `${r.name} · ${r.count}`;
    return b;
  }));
}

// What step 2 shows: the mix tiles (Deezer) and whether the own-links field is open.
const setup = { mixes: new Set(DEFAULT_SETTINGS.mixes), customLinks: false };

function renderMixes() {
  $('#mixes').replaceChildren(...MIXES.map((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mix';
    b.dataset.mix = m.id;
    b.setAttribute('aria-pressed', String(setup.mixes.has(m.id)));
    b.innerHTML = `<b>${esc(m.name)}</b><span>${esc(m.info)}</span>`;
    return b;
  }));
}

// Step 1 decides what the rest of the setup screen shows.
function renderSource() {
  const deezerMode = (document.querySelector('input[name=source]:checked')?.value || DEFAULT_SETTINGS.source) === 'deezer';
  $('#spotify-block').hidden = deezerMode;
  $('#start-pos-field').hidden = deezerMode;
  $('#limit-note').hidden = !deezerMode;
  $('#start-btn').disabled = !deezerMode && !auth.connected;
  // Deezer: mixes first; own links only on request. Spotify: own links are the only way (the mixes are Deezer songs).
  $('#mixes-block').hidden = !deezerMode;
  $('#custom-block').hidden = deezerMode && !setup.customLinks;
  $('#custom-toggle').textContent = setup.customLinks ? '− Eigene Playlists weglassen' : '+ Eigene Playlist dazunehmen (Deezer- oder Spotify-Link)';
  $('#playlists').placeholder = deezerMode ? 'https://www.deezer.com/playlist/…\nein Link pro Zeile' : 'https://open.spotify.com/playlist/…\nein Link pro Zeile';
  $('#playlists-hint').textContent = deezerMode
    ? 'Kommt zu den Mixen dazu. Spotify-Links gehen auch: die Songs werden auf Deezer gesucht.'
    : 'Ein oder mehrere Spotify-Playlist- oder Album-Links. Alle Songs kommen in einen Topf.';
}

async function refreshConnection() {
  const connected = auth.connected;
  $('#spotify-disconnected').hidden = connected;
  $('#spotify-connected').hidden = !connected;
  renderSource();
  if (!connected) return;
  try {
    const me = await api('/me');
    $('#me-name').textContent = me.display_name || me.id;
    $('#me-warn').textContent = me.product && me.product !== 'premium' ? 'Zum Abspielen brauchst du Spotify Premium' : '';
    if (MOBILE) loadDevices();
    else spotify.init();
  } catch (err) {
    if (!auth.connected) return refreshConnection();
    $('#me-name').textContent = '?';
    $('#me-warn').textContent = err.message;
    if (err.notRegistered) $('#start-btn').disabled = true;
    toast(`Spotify: ${err.message}`, 'error', 12000);
  }
}

// ====================================================================== game state

const game = {
  s: null,
  players: [], // { name, score, out: null | 'wrong' | 'pass' }
  ready: [false, false], // after a round: who wants the next song (both must, see ready())
  tracks: [],
  index: -1,
  phase: 'idle', // fading (outro of the previous song) | loading | playing | answering | reveal | over
  buzzer: null,
  elapsedMs: 0,
  runningSince: null,
  result: null,
  answerShown: false, // title revealed with Space while a player is answering
  transition: false, // the outro just ran: cover Spotify's song switch with the drop (see nextRound)
  startAt: 0, // ms into the song where this round starts
  prevUri: null, // song the player was on before this round started
  history: [],
  token: 0,
  failures: 0,
};

const currentTrack = () => game.tracks[game.index];
const elapsed = () => game.elapsedMs + (game.runningSince ? performance.now() - game.runningSince : 0);

function startClock() { game.runningSince = performance.now(); }
function stopClock() {
  game.elapsedMs = elapsed();
  game.runningSince = null;
}

// The faster the buzz, the more points: MAX_POINTS right away, sliding down to 1 as the timer runs out.
function pointsFor(ms) {
  const left = 1 - ms / (game.s.limit * 1000);
  return Math.max(1, Math.ceil(MAX_POINTS * left));
}

// When the opponent said "don't know", the song is likely from player i's own playlist: it scores less.
// (A wrong answer doesn't count — the opponent at least knew enough to try.)
const opponentPassed = (i) => game.players[1 - i]?.out === 'pass' && game.s.passFactor < 1;
function pointsForPlayer(i, ms) {
  const base = pointsFor(ms);
  return opponentPassed(i) ? Math.max(1, Math.round(base * game.s.passFactor)) : base;
}
const factorLabel = () => ({ 0.5: '½', 0.25: '¼' })[game.s.passFactor] || `×${game.s.passFactor}`;

function startPosition(t) {
  if (game.s.startPos !== 'random' || !t.durationMs) return 0;
  const room = t.durationMs - game.s.limit * 1000 - 5000;
  return room > 0 ? Math.floor(room * (0.1 + Math.random() * 0.7)) : 0;
}

async function startGame(event) {
  event.preventDefault();
  const s = readSettingsForm();
  store.set(LS.settings, s);
  const deezerMode = s.source === 'deezer';
  if (!deezerMode && !auth.connected) return toast('Verbinde zuerst Spotify – oder nimm Deezer, das geht ohne Login.', 'error');
  if (!deezerMode && MOBILE && !spotify.deviceId) return toast('Wähl aus, wo die Musik läuft (Schritt 1) – Spotify-App öffnen und auf Aktualisieren tippen.', 'error', 7000);

  const useLinks = !deezerMode || s.customLinks;
  const { sources, invalid } = useLinks ? parseSources(s.playlists) : { sources: [], invalid: [] };
  if (invalid.length) toast(`Unbekannte Links ignoriert: ${invalid.join(' ')}`, 'error', 7000);
  let usable = deezerMode ? sources : sources.filter((x) => x.service === 'spotify');
  if (usable.length < sources.length) toast('Deezer-Links gehen nur mit Deezer als Musikquelle (Schritt 1).', 'error', 7000);
  if (deezerMode) usable = MIXES.filter((m) => s.mixes.includes(m.id)).map((m) => ({ service: 'mix', mix: m, type: 'mix', id: m.id })).concat(usable);
  if (!usable.length) return toast(deezerMode ? 'Wähl mindestens einen Mix – oder füg eine eigene Playlist dazu.' : 'Füg mindestens einen Spotify-Playlist-Link ein.', 'error');

  // Must happen inside the click handler so browsers allow audio.
  sfx.init();
  if (!deezerMode) spotify.player?.activateElement?.();
  music = deezerMode ? deezerPlayer : spotify;
  if (deezerMode) {
    // the previews are 30 s long and always start at the same spot
    s.limit = Math.min(s.limit, DEEZER_MAX_LIMIT);
    s.startPos = 'intro';
  }

  showScreen('loading');
  const log = $('#load-log');
  log.innerHTML = '';
  $('#load-back').hidden = true;
  const addLog = (text, kind = '') => {
    const li = document.createElement('li');
    li.className = kind;
    li.textContent = text;
    log.append(li);
    return li;
  };

  // All sources load at the same time; ones loaded in the last hours come from the browser's cache.
  const loadStarted = performance.now();
  const results = await Promise.all(usable.map(async (src) => {
    const li = addLog(src.mix ? `Lade Mix «${src.mix.name}»…` : `Lade ${src.type === 'album' ? 'Album' : 'Playlist'}…`);
    try {
      if (src.short) Object.assign(src, await deezerApi(`resolve?url=${encodeURIComponent(src.short)}`), { short: null });
      const progress = (text) => { li.textContent = typeof text === 'number' ? `Lade Playlist… ${text} Songs` : text; };
      let data;
      let notes;
      if (deezerMode) {
        const key = `msc.dzsource.${src.service}.${src.type}.${src.id}`;
        const hit = store.get(key);
        const fresh = hit && Date.now() - hit.at < SOURCE_CACHE_MS;
        data = fresh ? hit.data : await loadForDeezer(src, progress);
        if (!fresh) cacheSource(src, data, key);
        notes = [src.service === 'spotify' && data.note, fresh && 'gemerkt'];
      } else {
        const cached = await cachedSource(src);
        data = cached?.current ? cached.data : null;
        let outdated = false;
        if (!data) {
          try {
            data = await (src.type === 'album' ? fetchAlbum(src.id) : fetchPlaylist(src.id, progress));
            cacheSource(src, data);
          } catch (err) {
            if (!cached) throw err;
            debugLog('load failed, using older copy', src.type, src.id, '|', err.message);
            data = cached.data;
            outdated = true;
          }
        }
        notes = [data.note, cached?.current && 'gemerkt', outdated && 'ältere Version, Spotify antwortet nicht'];
      }
      if (!src.mix) rememberSource(src, data); // "Zuletzt gespielt" is for own links
      notes = notes.filter(Boolean).join(', ');
      li.textContent = `${data.name} – ${data.tracks.length} Songs${notes ? ` (${notes})` : ''}`;
      li.className = 'ok';
      return data.tracks;
    } catch (err) {
      debugLog('load failed', src.service, src.type, src.id, '|', err.message);
      li.textContent = `${src.type || 'Link'} ${src.short || src.id}: ${err.message}`;
      li.className = 'bad';
      return [];
    }
  }));
  debugLog('sources loaded in', `${((performance.now() - loadStarted) / 1000).toFixed(1)}s`);
  const tracks = dedupe(results.flat());
  if (!tracks.length) {
    addLog('Keine abspielbaren Songs gefunden – prüf deine Links.', 'bad');
    $('#load-back').hidden = false;
    return;
  }

  const deviceLine = addLog('Boxen werden aufgedreht…');
  try {
    await withTimeout(music.init(), 15000, 'The Spotify player did not start in time. Reload the page and try again.');
    await music.transfer();
    deviceLine.textContent = `Boxen bereit – ${tracks.length} Songs im Topf${deezerMode ? ' (Ausschnitte via Deezer)' : ''}`;
    deviceLine.className = 'ok';
  } catch (err) {
    deviceLine.textContent = err.message;
    deviceLine.className = 'bad';
    $('#load-back').hidden = false;
    return;
  }
  await sleep(600);

  game.s = s;
  game.players = s.names.map((name) => ({ name, score: 0, out: null }));
  game.tracks = shuffle(tracks);
  debugLog('game start:', s.source, '|', tracks.length, 'songs from', usable.length, 'source(s) | first to', s.target, `| ${s.limit}s per song, start: ${s.startPos}`);
  newMatch();
}

async function newMatch() {
  game.players.forEach((p) => { p.score = 0; p.out = null; });
  game.history = [];
  game.index = -1;
  game.failures = 0;
  game.phase = 'idle';
  showScreen('game');
  render();
  await countdown();
  nextRound();
}

async function nextRound({ fade = false } = {}) {
  const token = ++game.token;
  if (fade) {
    // Outro: the song rings on for a few seconds and fades out. It's still playing, so its state updates
    // must not start the next round while we're in this phase.
    Object.assign(game, { phase: 'fading', outroEndsAt: performance.now() + OUTRO_MS, hurry: false });
    render();
    // (a 30-second Deezer clip may run out before the outro is over: then go on right away)
    while (!game.hurry && performance.now() < game.outroEndsAt - OUTRO_FADE_MS && !(music.remainingMs?.() < (music.crossfadeMs || 0) + 500)) {
      await sleep(50);
      if (token !== game.token) return;
    }
    if (!music.crossfade) {
      // DJ transition. Spotify streams one song at a time, so two songs can't overlap: the old one fades down
      // under a rising sweep, then a drop covers the moment Spotify switches to the new song (sfx.riser/drop).
      // Deezer clips play in the browser and really overlap instead (deezerPlayer.playFrom).
      const fadeMs = game.hurry ? QUICK_FADE_MS : OUTRO_FADE_MS;
      sfx.riser(fadeMs / 1000);
      await music.fade(music.userVolume * HANDOVER_LEVEL, fadeMs);
      if (token !== game.token) return;
      game.transition = true;
    }
  }
  game.phase = 'loading';
  if (decided()) return endGame({ record: true });
  if (++game.index >= game.tracks.length) {
    toast('Das war der letzte Song deiner Playlists!');
    return endGame({ record: true });
  }
  const t = currentTrack();
  Object.assign(game, {
    buzzer: null, elapsedMs: 0, runningSince: null, result: null, answerShown: false, startAt: startPosition(t),
  });
  game.players.forEach((p) => { p.out = null; });
  if (t.image) new Image().src = t.image; // preload the cover for the reveal
  render();

  const state = await music.state();
  game.prevUri = state?.track_window?.current_track?.uri ?? null; // the song that was on before this round
  if (game.transition) {
    game.transition = false;
    sfx.drop();
  }
  try {
    await music.playFrom(game.tracks, game.index, game.startAt);
  } catch (err) {
    if (token !== game.token) return;
    if (err.notRegistered) {
      toast(err.message, 'error', 15000);
      return endGame();
    }
    skipBroken(`${err.status ? `${err.status} ` : ''}${err.message}`);
    return;
  }
  // player_state_changed usually starts the round; polling covers missed events.
  const started = performance.now();
  let nudged = false;
  while (token === game.token && game.phase === 'loading') {
    const now = await music.state();
    if (tryBegin(now)) return;
    // Loaded but sitting paused: give it a push once.
    if (!nudged && now?.paused && sameTrack(now.track_window?.current_track, t) && performance.now() - started > 1500) {
      nudged = true;
      debugLog('round', game.index + 1, 'loaded but paused — resuming');
      music.resume();
    }
    if (performance.now() - started > 7000) return skipBroken('Spotify did not start it');
    await sleep(music.pollMs);
  }
}

// Start the round once the player reports a *new* song playing at the expected spot.
function tryBegin(state) {
  if (game.phase !== 'loading' || !state || state.paused || state.loading) return false;
  const cur = state.track_window?.current_track;
  if (!cur || (cur.uri === game.prevUri && !sameTrack(cur, currentTrack()))) return false;
  // Ignore the brief moment a skipped-to track plays from 0:00 before we seek to the random start spot.
  if (Math.abs(state.position - game.startAt) > 4000) return false;
  syncToPlayer(cur);
  beginPlaying();
  return true;
}

// Make sure the answer we show is the song that's actually playing: Spotify may skip songs it can't play
// in your country, or play a relinked version.
function syncToPlayer(cur) {
  const coverOf = (c) => [...(c.album?.images || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || '';
  const t = currentTrack();
  if (sameTrack(cur, t)) {
    // Songs from a public embed page come without cover/album; take them from the player.
    if (!t.image) t.image = coverOf(cur);
    if (!t.album) t.album = cur.album?.name || '';
    return;
  }
  const j = game.tracks.findIndex((x, k) => k > game.index && sameTrack(cur, x));
  if (j !== -1) {
    // Spotify started a later song from the batch: move that one up, keep the others for later rounds.
    debugLog('spotify played', cur.name, 'instead of', t.name, '— moving it up');
    const [playing] = game.tracks.splice(j, 1);
    game.tracks.splice(game.index, 0, playing);
    return syncToPlayer(cur);
  }
  debugLog('playing', cur.name, 'instead of', currentTrack().name, '— using what plays');
  game.tracks[game.index] = {
    ...currentTrack(),
    uri: cur.uri,
    id: cur.id,
    name: cur.name,
    title: cleanTitle(cur.name),
    artists: (cur.artists || []).map((a) => a.name).join(', '),
    album: cur.album?.name || '',
    year: '',
    image: coverOf(cur),
  };
}

function skipBroken(reason) {
  const t = currentTrack();
  debugLog('skip broken', t.name, '|', reason);
  $('#status').textContent = 'Der Song läuft nicht – nehme einen anderen…';
  if (++game.failures >= 5) {
    toast('Zu viele Abspielfehler. Ist Spotify Premium aktiv und der Browser unterstützt?', 'error', 9000);
    return endGame();
  }
  game.tracks.splice(game.index, 1);
  game.index--;
  nextRound();
}

function onPlayerState(state) {
  const t = currentTrack();
  if (!state || !t || music !== spotify) return;
  if (game.phase === 'loading') {
    tryBegin(state);
    return;
  }
  // Spotify moves on to the queued song by itself when one ends; never let the next song leak early.
  const cur = state.track_window?.current_track;
  if (['playing', 'answering', 'reveal', 'fading'].includes(game.phase) && cur && !sameTrack(cur, t) && !state.paused) {
    debugLog('paused early start of', cur.name);
    spotify.pause();
  }
}

// The SDK reports transient errors while switching tracks; a song that really fails is caught by the
// start-up timeout in nextRound, so just record these.
function onPlaybackError(message) {
  debugLog('playback_error', message, '| phase', game.phase);
}

function beginPlaying() {
  if (game.phase !== 'loading') return;
  game.phase = 'playing';
  game.failures = 0;
  startClock();
  const t = currentTrack();
  debugLog('round', game.index + 1, 'started:', t.name, '—', t.artists, `| fade in from ${music.level.toFixed(2)}`);
  if (!music.crossfade) music.fade(music.userVolume, FADE_IN_MS); // Deezer fades in itself (playFrom)
  render();
}

// via: 'keyboard' | 'phone' | 'click' — logged so phone latency issues can be spotted.
function buzz(i, via = 'keyboard') {
  const p = game.players[i];
  if (game.phase === 'reveal') return ready(i, via); // after a round the buzzer means "next song, please"
  if (game.phase !== 'playing' || !p || p.out) return;
  stopClock();
  debugLog('round', game.index + 1, 'buzz:', p.name, `via ${via} after ${(game.elapsedMs / 1000).toFixed(2)}s`);
  game.phase = 'answering';
  game.buzzer = i;
  music.pause();
  sfx.buzz(i);
  flash(i);
  render();
}

// "I don't know this song" — see canPass.
function pass(i, via = 'keyboard') {
  const p = game.players[i];
  if (!canPass(i)) return;
  debugLog('round', game.index + 1, 'pass:', p.name, `via ${via}`);
  p.out = 'pass';
  sfx.pass();
  if (game.players.every((q) => q.out)) return reveal({ type: 'nobody' });
  render();
}

function judge(correct) {
  if (game.phase !== 'answering') return;
  const i = game.buzzer;
  const p = game.players[i];
  debugLog('round', game.index + 1, 'judged', correct ? 'correct' : 'wrong', 'for', p.name, game.answerShown ? '(song was shown)' : '');
  if (correct) {
    const points = pointsForPlayer(i, game.elapsedMs);
    p.score += points;
    sfx.correct();
    confetti.burst($(`#p${i}`), playerColors(i));
    reveal({ type: 'correct', player: i, points, ms: game.elapsedMs, reduced: opponentPassed(i) });
    return;
  }
  if (game.s.penalty) p.score -= WRONG_PENALTY;
  p.out = 'wrong';
  game.buzzer = null;
  sfx.wrong();
  // Once the title was on screen the other player has seen it, so the round is over.
  if (game.answerShown || game.players.every((q) => q.out)) return reveal({ type: 'nobody' });
  game.phase = 'playing';
  startClock();
  music.resume();
  render();
}

function showAnswer() {
  if (game.phase !== 'answering' || game.answerShown) return;
  game.answerShown = true;
  sfx.beep(660);
  render();
}

function skip() {
  if (game.phase === 'playing') reveal({ type: 'skipped' });
  else if (game.phase === 'loading') skipBroken('skipped while loading'); // stuck song: move on
}

function timeUp() {
  sfx.timeout();
  reveal({ type: 'timeout' });
}

function reveal(result) {
  if (game.runningSince) stopClock();
  game.phase = 'reveal';
  game.result = result;
  game.ready = [false, false];
  game.history.push({ track: currentTrack(), result });
  debugLog('round', game.index + 1, 'result:', result.type, result.points ? `+${result.points}` : '', '| score', game.players.map((p) => p.score).join(':'));
  music.resume(); // the full song keeps playing while everyone sees the answer
  watchSongEnd(game.token);
  render();
}

// Listen to the song till (nearly) the end, then move on by itself, so the answer screen never falls silent.
async function watchSongEnd(token) {
  while (token === game.token && game.phase === 'reveal') {
    await sleep(MOBILE ? 3000 : 1000); // the phone version polls Spotify's API: go easy on it
    if (token !== game.token || game.phase !== 'reveal') return;
    const s = await music.state();
    const duration = s?.duration || s?.track_window?.current_track?.duration_ms;
    if (s && !s.paused && duration && duration - s.position < OUTRO_MS + (music.crossfadeMs || 0) + 1500) {
      debugLog('round', game.index + 1, 'song is ending — on to the next one');
      next();
      return;
    }
  }
}

// The next song only comes once both players want it, so a song someone likes can play on a while.
// (When the song is about to end, watchSongEnd moves on regardless.)
function ready(i, via = 'keyboard') {
  if (game.phase !== 'reveal' || game.ready[i]) return;
  game.ready[i] = true;
  debugLog('round', game.index + 1, 'ready:', game.players[i].name, `via ${via}`);
  sfx.buzz(i);
  if (game.ready.every(Boolean)) return next();
  render();
}

const decided = () => game.players.some((p) => p.score >= game.s.target);

function next() {
  if (game.phase === 'fading') {
    if (!game.hurry) {
      game.hurry = true; // nextRound shortens the outro
      render();
    }
    return;
  }
  if (game.phase !== 'reveal') return;
  if (decided()) return endGame({ keepMusic: true, record: true }); // the winning song plays on over the trophy
  nextRound({ fade: true });
}

// record: the game was played to the end (target score or last song), so it counts for the scoreboard.
// Games stopped from the menu or by playback errors don't.
function endGame({ keepMusic = false, record = false } = {}) {
  game.token++;
  game.phase = 'over';
  if (record) recordResult();
  debugLog('game over after', game.history.length, 'songs | score', game.players.map((p) => `${p.name} ${p.score}`).join(' : '));
  music.fadeId++; // stop any running fade
  if (keepMusic) music.setVolume(music.userVolume); // the deciding song plays out under the scorecard
  else music.pause().then(() => music.setVolume(music.userVolume));
  renderOver();
  showScreen('over');
  sfx.fanfare();
  const [a, b] = game.players;
  if (a.score !== b.score) {
    const w = a.score > b.score ? 0 : 1;
    confetti.burst($('.trophy'), playerColors(w), 220);
  }
}

// Players are told apart by name only: "Anna" and "anna" are two rows.
function recordResult() {
  const board = store.get(LS.scoreboard, {});
  game.players.forEach((p, i) => {
    const other = game.players[1 - i];
    const row = board[p.name] || (board[p.name] = { won: 0, lost: 0, drawn: 0 });
    row[p.score > other.score ? 'won' : p.score < other.score ? 'lost' : 'drawn']++;
  });
  store.set(LS.scoreboard, board);
}

// ====================================================================== rendering

// During the outro the screen keeps showing the answer.
const shownPhase = () => (game.phase === 'fading' ? 'reveal' : game.phase);

function playerStatus(p, i) {
  const { buzzer, result } = game;
  const phase = shownPhase();
  if (game.phase === 'reveal') {
    const scored = result?.type === 'correct' && result.player === i ? `+${result.points}${result.points >= 8 ? ' Turbo!' : '!'} · ` : '';
    return scored + (game.ready[i] ? 'Bereit ✓' : `${MOBILE ? 'Tippen' : KEY_LABELS[i].buzz} für den nächsten Song`);
  }
  if (phase === 'answering' && buzzer === i) return 'Gebuzzert!';
  if (phase === 'reveal' && result?.type === 'correct' && result.player === i) return `+${result.points}${result.points >= 8 ? ' Turbo!' : '!'}`;
  if (p.out === 'wrong' && phase !== 'reveal') return 'Falsch – diese Runde raus';
  if (p.out === 'pass' && phase !== 'reveal') return 'Kenn ich nicht';
  if (phase === 'playing') return MOBILE ? 'Tippen zum Buzzern' : `${KEY_LABELS[i].buzz} zum Buzzern`;
  return ' ';
}

function statusText() {
  const { phase, players, buzzer, result } = game;
  const secs = (ms) => (ms / 1000).toFixed(1);
  switch (phase) {
    case 'idle': return 'Mach dich bereit…';
    case 'fading':
      if (!game.hurry) return `Nächster Song in ${Math.max(1, Math.ceil((game.outroEndsAt - performance.now()) / 1000))}…`;
    // falls through
    case 'loading': return 'Nächste Platte wird aufgelegt…';
    case 'playing': {
      const outIdx = players.findIndex((p) => p.out);
      if (outIdx === -1) return MOBILE ? 'Wer kennt ihn? Tipp auf deine Seite!' : 'Wer kennt ihn? Buzzer mit A oder L!';
      const other = 1 - outIdx;
      return `${players[outIdx].name} ist raus – ${players[other].name}, ${MOBILE ? 'tipp zum Buzzern' : `drück ${KEY_LABELS[other].buzz}`}!`;
    }
    case 'answering': return game.answerShown
      ? `Hat ${players[buzzer].name} recht?`
      : `${players[buzzer].name} hat nach ${secs(game.elapsedMs)} s gebuzzert – wie heisst der Song?`;
    case 'reveal':
      switch (result?.type) {
        case 'correct': return `${players[result.player].name} hat's in ${secs(result.ms)} s! +${result.points}`
          + (result.reduced ? ` (${factorLabel()} – ${players[1 - result.player].name} kannte ihn nicht)` : '');
        case 'timeout': return 'Zeit um – keiner hat\'s!';
        case 'nobody': return players.every((p) => p.out === 'pass') ? 'Den kannte keiner!' : 'Keiner hat\'s – schade!';
        default: return 'Übersprungen.';
      }
    default: return '';
  }
}

function renderActions() {
  const { phase, answerShown, hurry, buzzer } = game;
  const key = `${phase}:${answerShown}:${hurry}:${buzzer}`;
  const judge_ = buzzer === null ? null : KEY_LABELS[1 - buzzer];
  const keyHint = (k) => (MOBILE || !k ? '' : ` <kbd>${k}</kbd>`);
  if (ui.actionsKey === key) return;
  ui.actionsKey = key;
  const peek = '<button class="btn ghost small" data-action="peek">Spicken <kbd>H</kbd></button>';
  const show = answerShown ? '' : '<button class="btn next" data-action="show">Song zeigen <kbd>Leertaste</kbd></button>';
  const html = {
    playing: `<button class="btn ghost small" data-action="skip">Überspringen <kbd>Esc</kbd></button>${peek}`,
    answering: `${show}<button class="btn ok" data-action="correct">Richtig${keyHint(judge_?.right)}</button>
                <button class="btn bad" data-action="wrong">Falsch${keyHint(judge_?.wrong)}</button>`,
    reveal: '',
    fading: hurry ? '' : '<button class="btn next" data-action="next">Sofort weiter <kbd>Enter</kbd></button>',
  }[phase] || '';
  $('#actions').innerHTML = html;
}

function render() {
  const { players, result } = game;
  const phase = shownPhase();
  const t = currentTrack();

  players.forEach((p, i) => {
    const el = $(`#p${i}`);
    el.querySelector('.pname').textContent = p.name;
    el.querySelector('.score').textContent = p.score;
    el.querySelector('.pbar i').style.width = `${Math.max(0, Math.min(1, p.score / game.s.target)) * 100}%`;
    el.querySelector('.pstatus').textContent = playerStatus(p, i);
    el.classList.toggle('buzzed', phase === 'answering' && game.buzzer === i);
    el.classList.toggle('locked', p.out === 'wrong' && phase !== 'reveal');
    el.classList.toggle('passed', p.out === 'pass' && phase !== 'reveal');
    el.classList.toggle('scored', phase === 'reveal' && result?.type === 'correct' && result.player === i);
    el.classList.toggle('can-pass', phase === 'playing' && canPass(i));
  });

  $('#round-info').textContent = game.index >= 0
    ? `Song ${game.index + 1} von ${game.tracks.length} · bis ${game.s.target}`
    : `Bis ${game.s.target} Punkte`;

  const disc = $('#disc');
  disc.classList.toggle('spin', ['playing', 'answering', 'reveal'].includes(phase));
  disc.classList.toggle('paused', phase === 'answering');

  const revealed = phase === 'reveal' || (phase === 'answering' && game.answerShown);
  $('#disc-wrap').classList.toggle('revealed', revealed);
  const cover = $('#cover');
  if (revealed && t?.image) cover.src = t.image;
  else cover.removeAttribute('src');

  $('#answer').hidden = !revealed;
  if (revealed && t) {
    $('#a-title').textContent = t.title;
    $('#a-orig').textContent = t.name !== t.title ? t.name : '';
    $('#a-artist').textContent = t.artists;
    $('#a-meta').textContent = [t.album, t.year, `aus «${t.source}»`, t.uri.startsWith('deezer:') && 'Ausschnitt: Deezer'].filter(Boolean).join(' · ');
  }

  $('#status').textContent = statusText();
  if (!['playing', 'answering'].includes(phase)) $('#peek').hidden = true;
  renderActions();
  renderClock();
  phones.push();
}

function renderClock() {
  const limitMs = game.s.limit * 1000;
  const ms = ['playing', 'answering', 'reveal'].includes(shownPhase()) ? elapsed() : 0;
  $('#clock').textContent = game.phase === 'loading' ? '…' : (ms / 1000).toFixed(1);
  const ring = $('#ring');
  ring.style.strokeDashoffset = RING_CIRCUMFERENCE * Math.min(1, ms / limitMs);
  ring.classList.toggle('warn', game.phase === 'playing' && limitMs - ms < 5000);
  // Who could score right now: while playing, the one player left if the other passed; when answering, the buzzer.
  const scorer = game.phase === 'answering' ? game.buzzer : game.players.findIndex((p, i) => !p.out && opponentPassed(i));
  const reduced = scorer >= 0 && opponentPassed(scorer);
  const pts = scorer >= 0 ? pointsForPlayer(scorer, game.phase === 'answering' ? game.elapsedMs : ms) : pointsFor(ms);
  const note = reduced ? ` · ${factorLabel()}, ${game.players[1 - scorer].name} kennt ihn nicht` : '';
  const worth = { playing: `${pts} Punkte${note}`, answering: `um ${pts} Punkte${note}` }[game.phase];
  $('#worth').textContent = worth || '';
}

function tick() {
  if (ui.screen === 'game' && game.s) {
    if (game.phase === 'playing' && elapsed() >= game.s.limit * 1000) timeUp();
    if (game.phase === 'fading') {
      const text = statusText(); // countdown
      if ($('#status').textContent !== text) $('#status').textContent = text;
    }
    renderClock();
  }
  requestAnimationFrame(tick);
}

function setPeek(on) {
  const t = currentTrack();
  const el = $('#peek');
  el.hidden = !(on && t && ['playing', 'answering'].includes(game.phase));
  if (!el.hidden) el.textContent = `${t.title} — ${t.artists}`;
}

function renderOver() {
  const [a, b] = game.players;
  $('#winner-title').textContent = a.score === b.score
    ? 'Unentschieden!'
    : `${(a.score > b.score ? a : b).name} gewinnt!`;

  $('#final-scores').innerHTML = game.players.map((p, i) => `
    <div class="p${i + 1} ${p.score > game.players[1 - i].score ? 'win' : ''}">
      <div class="fs-name">${esc(p.name)}</div>
      <div class="fs-score">${p.score}</div>
    </div>`).join('');

  renderScoreboard();

  $('#history').innerHTML = game.history.map(({ track: t, result: r }) => {
    const badge = r.type === 'correct'
      ? `<span class="badge p${r.player + 1}">+${r.points} ${esc(game.players[r.player].name)}</span>`
      : `<span class="badge">${{ timeout: 'Zeit um', nobody: 'Keiner', skipped: 'Übersprungen' }[r.type]}</span>`;
    const img = t.image ? `<img src="${esc(t.image)}" alt="">` : '<span class="noimg"></span>';
    return `<li>${img}<div><div class="h-title">${esc(t.title)}</div><div class="h-artist">${esc(t.artists)}</div></div>${badge}</li>`;
  }).join('') || '<li><span></span><div>Keine Songs gespielt.</div><span></span></li>';
}

function renderScoreboard() {
  const rows = Object.entries(store.get(LS.scoreboard, {}))
    .sort(([, a], [, b]) => b.won - a.won || a.lost - b.lost);
  const playing = new Set(game.players.map((p) => p.name));
  $('#scoreboard-wrap').hidden = !rows.length;
  $('#scoreboard').innerHTML = rows.map(([name, r], rank) => `
    <tr class="${playing.has(name) ? 'now' : ''}">
      <td>${rank + 1}.</td><td class="sb-name">${esc(name)}</td>
      <td>${r.won + r.lost + r.drawn}</td><td>${r.won}</td><td>${r.lost}</td><td>${r.drawn}</td>
    </tr>`).join('');
}

// ====================================================================== events

$('#setup-form').addEventListener('submit', startGame);
$('#mixes').addEventListener('click', (e) => {
  const id = e.target.closest('[data-mix]')?.dataset.mix;
  if (!id) return;
  if (setup.mixes.has(id)) setup.mixes.delete(id);
  else setup.mixes.add(id);
  renderMixes();
  store.set(LS.settings, readSettingsForm());
});
$('#custom-toggle').addEventListener('click', () => {
  setup.customLinks = !setup.customLinks;
  renderSource();
  store.set(LS.settings, readSettingsForm());
  if (setup.customLinks) $('#playlists').focus();
});
for (const r of document.querySelectorAll('input[name=source]')) {
  r.addEventListener('change', () => {
    store.set(LS.settings, readSettingsForm());
    renderSource();
  });
}
$('#menu-music').addEventListener('click', () => menuMusic.toggle());
// Browsers only allow sound after a tap: the first interaction with the setup screen starts the menu loop.
for (const type of ['pointerdown', 'keydown']) addEventListener(type, () => menuMusic.start(), { capture: true });
$('#devices-refresh').addEventListener('click', () => loadDevices());
$('#recent-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  const field = $('#playlists');
  const lines = field.value.split('\n').filter((l) => l.trim());
  const has = parseSources(field.value).sources.some((s) => s.id === b.dataset.id);
  field.value = (has
    ? lines.filter((l) => !l.includes(b.dataset.id))
    : [...lines, b.dataset.service === 'deezer' ? `https://www.deezer.com/${b.dataset.type}/${b.dataset.id}` : `https://open.spotify.com/${b.dataset.type}/${b.dataset.id}`]).join('\n');
  renderRecent();
});
$('#playlists').addEventListener('input', renderRecent);

$('#device-list').addEventListener('change', (e) => {
  spotify.deviceId = e.target.value;
  store.set(LS.device, spotify.deviceId);
  useDevice(spotify.deviceId);
  debugLog('device picked:', e.target.closest('label')?.textContent.trim().replace(/\s+/g, ' '));
});

$('#connect-btn').addEventListener('click', () => {
  const id = $('#client-id').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    toast('Das sieht nicht nach einer Spotify Client ID aus (32 Zeichen, 0-9 / a-f).', 'error');
    return;
  }
  store.set(LS.settings, readSettingsForm());
  auth.login(id);
});

$('#disconnect-btn').addEventListener('click', () => {
  auth.logout();
  spotify.disconnect();
  refreshConnection();
});

$('#load-back').addEventListener('click', () => showScreen('setup'));
$('#setup-btn').addEventListener('click', () => {
  music.pause();
  showScreen('setup');
});
$('#rematch-btn').addEventListener('click', () => {
  sfx.init();
  spotify.player?.activateElement?.();
  shuffle(game.tracks);
  newMatch();
});
$('#scoreboard-reset').addEventListener('click', () => {
  if (!confirm('Die ewige Tabelle wirklich löschen?')) return;
  store.del(LS.scoreboard);
  renderScoreboard();
});
$('#end-btn').addEventListener('click', () => {
  if (confirm('Spiel jetzt beenden?')) endGame();
});

$('#volume').addEventListener('change', (e) => e.target.blur()); // hand the keys back to the game
$('#volume').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  store.set(LS.volume, v);
  music.fadeId++; // the slider wins over a running fade
  music.setVolume(v);
  menuMusic.setVolume();
});

// Game buttons shouldn't steal focus, otherwise Enter/Space would also "click" them.
$('#screen-game').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});

$('#actions').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  ({ skip, show: showAnswer, correct: () => judge(true), wrong: () => judge(false), next })[action]?.();
});
$('#actions').addEventListener('pointerdown', (e) => {
  if (e.target.closest('[data-action="peek"]')) setPeek(true);
});
addEventListener('pointerup', () => setPeek(false));

for (const el of document.querySelectorAll('.player')) {
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pass')) return;
    buzz(Number(el.dataset.player), 'click');
  });
}
for (const el of document.querySelectorAll('[data-pass]')) {
  el.addEventListener('click', () => pass(Number(el.dataset.pass)));
}

// ====================================================================== Bluetooth controllers

// Any controller the browser sees as a gamepad (Xbox, PlayStation, Switch Pro, 8BitDo…). The first one
// connected plays for player 1, the second for player 2. Buttons follow the "standard" layout:
//   A / ✕  buzz, or "correct" while judging the other player's answer
//   B / ○  "don't know", or "wrong" while judging
//   X / □  show the song while judging
//   Y / △, Start / Options / +  after a round: ready for the next song (it comes once both are)
// Browsers only reveal a controller after one of its buttons was pressed with the page open.
const GAMEPAD_BUTTONS = { 0: 'a', 1: 'b', 2: 'show', 3: 'next', 9: 'next' };
const gamepads = {
  held: new Map(), // gamepad index → buttons held at the last poll, so a press counts once
  polling: false,

  connected() {
    return [...navigator.getGamepads()].filter(Boolean).sort((a, b) => a.index - b.index).slice(0, 2);
  },

  poll() {
    const pads = this.connected();
    if (!pads.length) {
      this.polling = false;
      return;
    }
    pads.forEach((pad, player) => {
      const before = this.held.get(pad.index) || new Set();
      const now = new Set();
      pad.buttons.forEach((b, i) => {
        if (!b.pressed) return;
        now.add(i);
        if (!before.has(i) && GAMEPAD_BUTTONS[i]) this.press(player, GAMEPAD_BUTTONS[i]);
      });
      this.held.set(pad.index, now);
    });
    requestAnimationFrame(() => this.poll());
  },

  press(player, button) {
    const judging = ui.screen === 'game' && canJudge(player);
    const action = {
      a: judging ? 'correct' : 'buzz',
      b: judging ? 'wrong' : 'pass',
      show: judging ? 'show' : null,
      next: 'next',
    }[button];
    if (action) phones.onPress({ player, action }, 'gamepad');
  },

  start() {
    if (this.polling) return;
    this.polling = true;
    requestAnimationFrame(() => this.poll());
  },
};
addEventListener('gamepadconnected', (e) => {
  const player = gamepads.connected().findIndex((pad) => pad.index === e.gamepad.index);
  debugLog('gamepad connected:', e.gamepad.id, '| mapping', e.gamepad.mapping || 'none', '| player', player + 1);
  if (player >= 0) toast(`Controller verbunden – spielt für ${game.players?.[player]?.name || `Spieler ${player + 1}`}`);
  gamepads.start();
});
addEventListener('gamepaddisconnected', (e) => {
  gamepads.held.delete(e.gamepad.index);
  toast('Controller getrennt');
});

addEventListener('keydown', (e) => {
  if (ui.screen !== 'game' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input:not([type=range]), textarea, select')) return;
  const key = e.key.toLowerCase();
  let handled = true;
  if (key === 'h') setPeek(true);
  else if (e.repeat) handled = ['enter', ' ', 'backspace', 'escape'].includes(key);
  else if (key in BUZZ_KEYS) buzz(BUZZ_KEYS[key]);
  else if (key in PASS_KEYS) pass(PASS_KEYS[key]);
  else if (key in JUDGE_KEYS) {
    const [i, correct] = JUDGE_KEYS[key];
    if (canJudge(i)) judge(correct);
  } else if (key === ' ') game.phase === 'answering' ? showAnswer() : game.phase === 'fading' && next();
  else if (key === 'enter') game.phase === 'fading' && next(); // after both said "next": skip the outro
  else if (key === 'escape') skip();
  else handled = false;
  if (handled) e.preventDefault();
});
addEventListener('keyup', (e) => {
  if (e.key.toLowerCase() === 'h') setPeek(false);
});

// ====================================================================== boot

(async function boot() {
  if (RETURNING_TO_MOBILE) return; // the page is about to switch to /mobile
  if (MOBILE) document.body.classList.add('mobile-mode');
  renderMenuMusic();
  fillSettingsForm(loadSettings());
  renderRecent();
  $('#redirect-uri').textContent = REDIRECT_URI;
  // A hosted install can provide the Spotify Client ID, so visitors only have to press "Connect".
  const config = await fetch('/config.json').then((r) => r.json()).catch(() => ({}));
  if (config.phones) phones.connect();
  if (config.phones) {
    // The hosted install offers both versions; link them to each other.
    const link = $('#mode-link');
    link.href = MOBILE ? '/' : '/mobile';
    link.textContent = MOBILE ? 'Mit Laptop? Zur Laptop-Version' : 'Kein Laptop? Nur mit Handys spielen';
    link.hidden = false;
  }
  for (const id of ['#name1', '#name2']) {
    $(id).addEventListener('input', () => {
      renderPhones();
      phones.push();
    });
  }
  if (config.clientId) {
    store.set(LS.clientId, config.clientId);
    $('#client-id-field').hidden = true;
    $('#client-id-hint').textContent = 'Log dich mit deinem Spotify-Konto ein. Zum Abspielen brauchst du Spotify Premium.';
  }
  $('#client-id').value = auth.clientId;
  $('#volume').value = store.get(LS.volume, 0.8);
  try {
    await auth.handleRedirect();
  } catch (err) {
    toast(err.message, 'error', 9000);
  }
  await refreshConnection();
  requestAnimationFrame(tick);
})();
