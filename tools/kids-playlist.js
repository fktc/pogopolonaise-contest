#!/usr/bin/env node
// Builds a private Spotify playlist of Swiss (mostly Mundart) kids' music.
// Uses the game's Spotify app and its redirect URI http://127.0.0.1:8888/, so stop the game server first.
// The Client ID comes from SPOTIFY_CLIENT_ID or, failing that, from a local ecosystem.config.js.
//   node tools/kids-playlist.js            → log in, search, create the playlist
//   node tools/kids-playlist.js --dry      → log in and only print the songs it would add
//   node tools/kids-playlist.js --add <playlist id> --only "Artist,Song query"
//                                          → append just those entries to an existing playlist
//   node tools/kids-playlist.js --add <playlist id> --remove "Title|Title" --only ""
//                                          → remove songs by exact title (titles can contain commas)
const http = require('node:http');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');

const localConfig = () => {
  try {
    return require('../ecosystem.config.js').apps[0].env.SPOTIFY_CLIENT_ID;
  } catch {
    return '';
  }
};
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || localConfig();
if (!CLIENT_ID) {
  console.error('Set SPOTIFY_CLIENT_ID to your Spotify app\'s Client ID.');
  process.exit(1);
}
const PORT = Number(process.env.PORT) || 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/`;
const API = 'https://api.spotify.com/v1';
// Letters of any script count (Cyrillic artist names), accents and punctuation don't.
const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const DRY = process.argv.includes('--dry');
const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const ADD_TO = process.argv.includes('--add') ? arg('--add') : null;
const REMOVE = process.argv.includes('--remove') ? arg('--remove').split('|').map((s) => norm(s)) : [];
const ONLY = process.argv.includes('--only') ? arg('--only').split(',').map((s) => norm(s)) : null;
const picked = (name) => !ONLY || ONLY.includes(norm(name));
const NAME = 'Schwiizer Chinderlieder';

// [artist, max songs]. The first four were asked for, the rest are well-known Swiss kids' acts,
// trimmed to their most popular songs.
const ARTISTS = [
  ['Schwiizergoofe', 8],
  ['Subzonic', 8],
  ['Lcone', 5],
  ['Stubete Gäng', 10],
  ['Andrew Bond', 4],
  ['Sternschnuppe', 3],
  ['Silberbüx', 3],
  ['Marius & die Jagdkapelle', 3],
  ['Bruno Hächler', 2],
  ['Linard Bardill', 2],
  ['Tischbombe', 2],
  ['Ваня Дмитриенко', 5], // Vanya Dmitrienko, Russian pop
];

// Single songs: [search query, words the title must contain, optional words the artist must contain].
const SONGS = [
  ['Hot Wheels Let\'s Race', 'lets race'],
  ['Go Big Go Hot Wheels', 'go big'],
  ['Sidi Abdel Assar Mani Matter', 'sidi abdel assar'],
  ['Zündhölzli Mani Matter', 'zundholzli'],
  ['Rote Rosen Focuspunkt', 'rote rosen', 'punkt'], // Focuspunkt or Fokuspunkt, not Freddy Breck
  ['Skiplausch Trio Eugster', 'skiplausch', 'eugster'],
  ['Böögg verbrännt Trio Eugster', 'boog', 'eugster'],
  ['Grüeni Banane Peter Reber', 'banane', 'reber'],
  ['Chinder vo Kolumbus', 'kolumbus'],
  ['Dreamer Stubete Gäng', 'dreamer', 'stubete'],
  ['Tanze i de Luft Dodo', 'luft', 'dodo'],
  ['Erste Tram Lo & Leduc', 'tram', 'leduc'],
  ['079 Lo & Leduc', '079', 'leduc'],
  ['Baby Ciao Dabu Fantastic', 'ciao', 'dabu'],
  ['Centuries Fall Out Boy', 'centuries', 'fall out boy'],
  ['Umbrella Rihanna', 'umbrella', 'rihanna'],
  ['Baby One More Time Britney Spears', 'one more time', 'britney'],
  ['Toxic Britney Spears', 'toxic', 'britney'],
  ['Gut genug KitschKrieg', 'gut genug', 'kitschkrieg'],
  ['Bauch Beine Po Shirin David', 'bauch beine po', 'shirin'],
  ['Ahnma Beginner', 'ahnma', 'beginner'],
  ['Hammerhart Beginner', 'hammerhart', 'beginner'],
  ['Italodisco The Kolors', 'italodisco', 'kolors'],
  ['Dance Monkey Tones and I', 'dance monkey', 'tones'],
  ['Geistertruck', 'geistertruck'],
  ['El Tren Minidisco', 'el tren', 'minidisco'],
  ['Baby Shark Pinkfong', 'baby shark', 'pinkfong'],
];

const b64url = (buf) => buf.toString('base64url');

function login() {
  const verifier = b64url(crypto.randomBytes(48));
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: 'playlist-read-private playlist-modify-private playlist-modify-public user-read-private',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
  });
  const url = `https://accounts.spotify.com/authorize?${query}`;
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const q = new URL(req.url, REDIRECT_URI).searchParams;
      if (!q.has('code') && !q.has('error')) return res.end();
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(q.has('code') ? 'Eingeloggt. Du kannst dieses Fenster schliessen.' : `Login fehlgeschlagen: ${q.get('error')}`);
      server.close();
      if (q.has('error')) return reject(new Error(`Spotify login failed: ${q.get('error')}`));
      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          grant_type: 'authorization_code',
          code: q.get('code'),
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }),
      });
      const json = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok) return reject(new Error(json.error_description || `Token request failed (${tokenRes.status})`));
      resolve(json.access_token);
    });
    server.on('error', (err) => reject(err.code === 'EADDRINUSE'
      ? new Error(`Port ${PORT} is busy. Stop the game server (it uses the same redirect URI) and try again.`)
      : err));
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`Log in to Spotify in your browser:\n${url}\n`);
      exec(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} "${url}"`);
    });
  });
}

async function api(token, path, options = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (res.status === 429 || (res.status >= 500 && attempt < 4)) { // rate limit or a passing hiccup
      await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || attempt * 2) * 1000));
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error?.message || `${res.status} on ${path}`), { status: res.status });
    return json;
  }
}

// Newer API versions renamed some endpoints; try the new one, fall back to the old one.
async function apiEither(token, paths, options) {
  for (const [i, path] of paths.entries()) {
    try {
      return await api(token, path, options);
    } catch (err) {
      if (i === paths.length - 1 || (err.status !== 403 && err.status !== 404)) throw err;
    }
  }
}

async function songsBy(token, name, max) {
  const found = await api(token, `/search?type=artist&limit=10&market=CH&q=${encodeURIComponent(name)}`);
  const artist = found.artists.items.find((a) => norm(a.name) === norm(name));
  if (!artist) return { artist: null, tracks: [] };

  // Track search sorts by popularity; two pages of 10 (the Development Mode maximum) are plenty.
  const tracks = [];
  const seen = new Set();
  for (const offset of [0, 10]) {
    const page = await api(token, `/search?type=track&limit=10&offset=${offset}&market=CH&q=${encodeURIComponent(`artist:"${name}"`)}`);
    for (const t of page.tracks.items) {
      const title = norm(t.name.replace(/\s*[-(].*$/, '')); // "Song - Live" and "Song (Remix)" count as Song
      if (t.explicit || seen.has(title) || !t.artists.some((a) => a.id === artist.id)) continue;
      seen.add(title);
      tracks.push(t);
    }
  }
  return { artist, tracks: tracks.slice(0, max) };
}

async function song(token, query, mustContain, artistContains = '') {
  const page = await api(token, `/search?type=track&limit=10&market=CH&q=${encodeURIComponent(query)}`);
  const matches = page.tracks.items.filter((t) => norm(t.name).includes(norm(mustContain))
    && t.artists.some((a) => norm(a.name).includes(norm(artistContains))));
  return { track: matches.find((t) => !t.explicit) || null, explicitOnly: matches.length > 0 && matches.every((t) => t.explicit) };
}

// Alternate between artists so the playlist doesn't play ten songs of the same band in a row.
function interleave(lists) {
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) lists.forEach((l) => l[i] && out.push(l[i]));
  return out;
}

async function removeSongs(token, playlistId) {
  const doomed = [];
  let next = null;
  let page = await apiEither(token, [`/playlists/${playlistId}/items?limit=50`, `/playlists/${playlistId}/tracks?limit=50`]);
  for (;;) {
    for (const entry of page.items) {
      const t = entry.item || entry.track; // newer API versions call it "item"
      if (t && REMOVE.includes(norm(t.name))) doomed.push(t);
    }
    if (!(next = page.next)) break;
    page = await api(token, next);
  }
  doomed.forEach((t) => console.log(`Removing: ${t.artists.map((a) => a.name).join(', ')} – ${t.name}`));
  const uris = doomed.map((t) => ({ uri: t.uri }));
  if (uris.length) {
    await apiEither(token, [`/playlists/${playlistId}/items`, `/playlists/${playlistId}/tracks`],
      { method: 'DELETE', body: JSON.stringify({ items: uris, tracks: uris }) });
  }
  console.log(`Removed ${doomed.length} of ${REMOVE.length} songs.\n`);
}

async function main() {
  const token = await login();
  if (ADD_TO && REMOVE.length) await removeSongs(token, ADD_TO).catch((err) => console.log(`Removing failed: ${err.message}\n`));
  const lists = [];
  for (const [name, max] of ARTISTS.filter(([name]) => picked(name))) {
    const { artist, tracks } = await songsBy(token, name, max).catch((err) => {
      console.log(`${name}: skipped (${err.message})`);
      return { artist: undefined, tracks: [] };
    });
    if (artist !== undefined) console.log(artist ? `${name}: ${tracks.length} songs` : `${name}: not found on Spotify, skipped`);
    lists.push(tracks);
  }
  const singles = [];
  for (const [query, mustContain, artistContains] of SONGS.filter(([query]) => picked(query))) {
    const { track, explicitOnly, error } = await song(token, query, mustContain, artistContains).catch((err) => ({ error: err }));
    if (track) singles.push(track);
    if (error) console.log(`${query}: skipped (${error.message})`);
    else console.log(track ? `${query}: found` : explicitOnly ? `${query}: only explicit versions, skipped` : `${query}: not found on Spotify, skipped`);
  }
  lists.push(singles);
  const tracks = interleave(lists);
  console.log('');
  tracks.forEach((t, i) => console.log(`${String(i + 1).padStart(2)}. ${t.artists.map((a) => a.name).join(', ')} – ${t.name}`));
  if (DRY) return;

  let playlist = { id: ADD_TO, external_urls: { spotify: `https://open.spotify.com/playlist/${ADD_TO}` } };
  if (!ADD_TO) {
    const body = JSON.stringify({ name: NAME, public: false, description: 'Mundart-Chinderlieder: Schwiizergoofe, Stubete Gäng, Lcone, Subzonic, Mani Matter, Hot Wheels & mehr' });
    const me = await api(token, '/me');
    playlist = await apiEither(token, ['/me/playlists', `/users/${me.id}/playlists`], { method: 'POST', body });
  }
  for (let i = 0; i < tracks.length; i += 100) {
    const uris = tracks.slice(i, i + 100).map((t) => t.uri);
    await apiEither(token, [`/playlists/${playlist.id}/items`, `/playlists/${playlist.id}/tracks`], { method: 'POST', body: JSON.stringify({ uris }) });
  }
  console.log(`\n${ADD_TO ? 'Added' : `Created "${NAME}" with`} ${tracks.length} songs: ${playlist.external_urls.spotify}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
