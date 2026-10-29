# Notes for coding agents

This file is for AI coding agents (Claude Code, Codex, Cursor, …) working in this repository. The human-facing docs are in [README.md](README.md).

The game is a two-player "name that tune" buzzer game in the browser. It has two music sources, chosen in step 1 of the setup screen:

- **Deezer (default):** needs no setup, account or login. It plays Deezer's 30-second previews. The setup screen offers ready-made mixes (`MIXES` in `public/app.js`), so players don't need playlist links at all; own Deezer or Spotify links can be added on top (Spotify songs are looked up on Deezer). For most users, `npm start` is all it takes.
- **Spotify:** full songs, but the user needs Spotify Premium and their own Spotify app. Only if they want this, walk them through *Connecting Spotify* below.

## What you can and can't do for the user

- **They have to do these steps themselves in their browser:** create the Spotify app, log in to Spotify and approve access. You can't do any of this for them. Give them exact steps and values, then wait for them to confirm each step.
- **Never ask for their Spotify password or a Client Secret.** The game uses the PKCE login flow, which needs only the **Client ID**. The Client ID isn't secret: it appears in every login URL. Even so, don't commit the user's Client ID (see *Privacy*).
- **You can do these steps:** start the server, check that it answers, read the terminal output, and work out errors from it.

## Connecting Spotify: walk the user through this

Requirements: **Spotify Premium**, because Spotify's in-browser player only streams for Premium accounts. Also a desktop browser (Chrome or Edge work best; Safari is unreliable) and **Node 18 or newer**. Check the Node version with `node -v`.

1. **Create a Spotify app.** Send the user to <https://developer.spotify.com/dashboard>. They log in with their Spotify account and click **Create app**.
   - App name and description: anything, e.g. "Song Contest".
   - **Redirect URI:** `http://127.0.0.1:8888/`. It must match exactly, including the trailing slash. Spotify rejects `localhost` for http redirect URIs, so it has to be `127.0.0.1`. If they'll use a different port, the port in this URI must match it.
   - Under the APIs/SDKs used, tick **Web API** and **Web Playback SDK**.
   - Accept the terms and save.
2. **Copy the Client ID.** It's in the app's **Settings → Basic Information**. Have the user paste it to you, or keep it and paste it into the game themselves.
3. **Add other players' accounts** if someone other than the app owner will log in: **Settings → User Management**, with name and email of their Spotify account. New apps are in *Development Mode*, which only allows the owner and listed users.
4. **Start the game.** Use `SPOTIFY_CLIENT_ID=<client id> npm start`, or just `npm start`, in which case the user pastes the Client ID on the setup screen and the browser remembers it. The server opens <http://127.0.0.1:8888/>; set `NO_OPEN=1` to stop it opening a browser. To check the server is up, run `curl -s http://127.0.0.1:8888/config.json`.
5. **The user clicks *Connect Spotify*** and approves access on Spotify's page. Spotify then sends them back to the game.
6. **Add playlists.** The user pastes playlist or album links, one per line, names the players and presses **¡Vamos a la playa!** Playlists from earlier games appear as buttons under *Zuletzt gespielt*.

### When it fails

| What the user sees | Cause and fix |
| --- | --- |
| `INVALID_CLIENT: Invalid redirect URI` on Spotify's page | The Redirect URI in the Spotify app doesn't exactly match the game's address. It should be `http://127.0.0.1:8888/` with the right port, a trailing slash and no `localhost`. Spotify can take a minute to apply a change. |
| `INVALID_CLIENT: Invalid client` | The Client ID is wrong or incomplete. Copy it again from the dashboard. |
| "Dieses Spotify-Konto darf die App noch nicht nutzen" / HTTP 403 everywhere | The account isn't the app owner and isn't listed under **User Management**. Add it there. |
| "Premium is required" / no sound | The account has no Premium; Spotify's in-browser player doesn't work without it. Also make sure only one tab runs the game, then reload. |
| `EADDRINUSE` / port 8888 busy | Another server already runs on that port, often a game server started earlier. Stop it, or run `PORT=9000 npm start` **and** change the Redirect URI to `http://127.0.0.1:9000/`. |
| A playlist loads only 100 songs, or not at all | In Development Mode, the Spotify API only lets the app read playlists the user owns or collaborates on. For other people's *public* playlists the game falls back to Spotify's public playlist page, which lists the first 100 songs. Other people's private playlists can't be read. Workaround: copy the songs into a playlist of the user's own. |
| Loading error with HTTP 5xx | Spotify had a temporary problem. The game retries and falls back to the public page or the copy saved in the browser; otherwise try again a minute later. |

The terminal running `npm start` logs what the game does: songs started, Spotify errors, loading problems. Read it when you diagnose something.

## Running and checking changes

- There are no dependencies and no build step: plain Node (`server.js`) and browser JavaScript (`public/`). Don't add npm packages or a bundler unless the user asks.
- There's no test suite. At least run `node --check` on every JS file you changed, then let the user try it in the browser. Headless browsers have no audio output, so playback can't be verified headlessly.
- The server serves `public/` straight from disk, so a page reload picks up front-end changes. Restart it only after changes to `server.js` or `sessions.js`.
- `tools/kids-playlist.js` is an optional helper that creates a Spotify playlist of Swiss kids' songs. It logs in on port 8888 itself, so stop the game server first. It also asks for extra permissions (to create and edit playlists), so the user approves once more.

## Conventions

- **UI text is German** (informal *du*, short, punchy). Code, comments and docs are English.
- **Look and feel:** follow the styleguide in the README's *Design* section. Only black, pink, yellow and white; flat; tilted sticker shapes.
- **Keys and rules:** the README's *How to play* and *Bluetooth controllers* sections describe the current behaviour. Update them when you change controls or rules.
- Match the surrounding code: small functions, comments that say *why*, no frameworks.

## Privacy: keep these out of git

- `ecosystem.config.js` (the real pm2 config with a Client ID and server paths) and `PRIVATE.md` (hosting notes) are git-ignored on purpose. For hosting, copy `ecosystem.config.example.js`.
- Never commit Client IDs, server addresses, domains, personal names or emails, or Spotify playlist IDs of the user's own playlists.
- `public/audio/menu-loop.wav` isn't in the repository. The menu stays silent without it; the user can add any short loop of their own.
