# Pogo & Polonaise — Song Contest

*Drei Akkorde. Alle singen mit.* A punk × Schlager styled, two-player "name that tune" buzzer game that plays songs from your own Spotify playlists, right in the browser.

## Design

Follows the Pogo & Polonaise styleguide: only black `#141414`, pink `#E8508A`, yellow `#F2E060` and white; flat (no gradients, no soft shadows, no transparency fades); Anton headlines in capitals with the hard pink offset, Yellowtail as script accent, Archivo for body text; tilted sticker shapes, starbursts, studs, a few sequins and one drip per screen. Player 1 is pink, player 2 black. UI copy is German (du, short, capitals); one claim per screen: "Drei Akkorde. Alle singen mit." on the game, "Kein Können. Nur Wollen." on the phone buzzer.

## One-time setup

Using a coding agent (Claude Code, Codex, Cursor…)? Just ask it to set the game up. [AGENTS.md](AGENTS.md) tells it how to walk you through connecting Spotify.


1. **Create a Spotify app** at <https://developer.spotify.com/dashboard>.
   - Redirect URI: `http://127.0.0.1:8888/` (must be exactly this; Spotify doesn't accept `localhost`)
   - APIs used: **Web API** and **Web Playback SDK**
   - Copy the **Client ID**.
2. If someone other than the app owner logs in, add their Spotify account under **User Management** in the app settings. Apps in Development Mode only allow listed users.
3. You need **Spotify Premium** and a desktop browser. Chrome, Edge or Firefox work best.

## Run it

```bash
npm start        # or: node server.js
```

This opens <http://127.0.0.1:8888/>. No `npm install` is needed because there are no dependencies, just Node 18+.

On the setup screen, paste your Client ID, click **Connect Spotify**, paste one or more playlist links (one per line; album links work too), name the players and press **¡Vamos a la playa!**

## How to play

The song plays, the record spins and the clock runs. The first player to recognise the song buzzes.

| Key | Action |
| --- | --- |
| `A` | Player 1 buzzes. After a round: player 1 is ready for the next song |
| `L` | Player 2 buzzes. After a round: player 2 is ready for the next song |
| `S` | Player 1: "I don't know this song" (sits out the round, no penalty). Only while the song plays, not after the other player buzzed |
| `K` | Player 2: "I don't know this song" |
| `Q` / `W` | Player 1 judges player 2's answer: **correct** / **wrong** |
| `I` / `O` | Player 2 judges player 1's answer: **correct** / **wrong** |
| `Space` | After a buzz: show the song title, artist and cover |
| `Enter` | During the outro: skip straight to the next song |
| `Esc` | Skip the song |
| hold `H` | Quizmaster peeks at the answer without revealing it |

When someone buzzes, the music pauses and the player says the answer out loud. The **other** player judges it, so nobody approves their own answer: press Space to show the song on screen, then Q/W (player 1 judging) or I/O (player 2 judging). A wrong answer puts that player out for the round and the music resumes for the other player; if the song was already shown, the round ends instead.

**Scoring:** the faster you buzz, the more you get. A song is worth 10 points the moment it starts and drops steadily to 1 point as the timer runs out; the screen shows what it's currently worth. If one player says "don't know" (S/K), the other player only gets **half** the points for that song (adjustable on the setup screen: half, a quarter or full) — when playlists are merged, a song only one player knows shouldn't be a free win. A wrong answer doesn't reduce anything. You can optionally lose 2 points for a wrong answer. The first player to reach the target score (default 50) wins. When both players are out, or time runs out, the answer is revealed and the song keeps playing. **Answer screen & transition:** after a round the full song keeps playing. The next song only comes once **both** players are ready (A and L, a controller's A/Y/Start, or *Nächster Song* on the phones), so a song someone likes can play on; when it's about to end, the game moves on by itself. Spotify streams only one song at a time, so two songs can't overlap; instead the transition is DJ-style: the old song fades down under a rising sweep, and a bass drop with a falling whoosh covers the moment Spotify switches to the next song, which then fades in. The sounds are generated in the browser. In the phone version Spotify's volume can only be faded on devices that allow it (speakers, computers, not phones); the sweep and drop cover the switch either way.

**Winning screen:** the song that decided the game simply plays on over the trophy and scorecard until it ends. Below the result, the **Ewige Tabelle** counts games, wins, losses and draws per player name over all games played to the end in this browser. Names aren't merged, so "Anna" and "anna" are two rows. Games stopped from the menu don't count. *Tabelle löschen* resets it.

**Menu music:** the setup screen loops `public/audio/menu-loop.wav`, starting with the first tap (browsers block sound before that). It can be switched off with the *Musik* button. The file isn't in the repository (it's a sample of a commercial song): drop in any short loop of your own, or the menu stays silent.

## Bluetooth controllers

Pair one or two game controllers (Xbox, PlayStation, Switch Pro, 8BitDo…) with the computer, open the game and press any button on each. Browsers only see a controller after a button press. The first controller plays for player 1, the second for player 2, and a message confirms each one.

| Button | Action |
| --- | --- |
| A / ✕ | Buzz. When the **other** player buzzed: their answer was **correct** |
| B / ○ | "I don't know this song". When the other player buzzed: their answer was **wrong** |
| X / □ | When the other player buzzed: show the song |
| Y / △ or Start / Options / + | After a round: ready for the next song (A works too) |

Like the phone buttons, nobody judges their own answer. The keyboard keeps working alongside the controllers. Cheap Bluetooth "selfie" remotes are not controllers but keyboards, so they only work if they happen to send one of the game's keys.

## Playing with phones only (no laptop)

Open `/mobile` on your hosted install (also linked from the main page) on one phone:

1. Connect Spotify, then pick **where the music plays**: the Spotify app on a phone, or any Spotify Connect speaker. Open the Spotify app first (play any song for a second) so it shows up, then tap *Refresh*. Mobile browsers can't run Spotify's in-browser player, so the game remote-controls that device instead.
2. Start the game. The two player panels are big tap-to-buzz areas, so a single phone on the table works.
3. Optional: players scan their QR codes to buzz from their own phones. When someone buzzes, the **other** player's phone shows *Show song / Right / Wrong* (nobody judges their own answer), and both phones get *Next song*. These phone buttons also work with the laptop version.

Differences from the laptop version: no volume blend between songs (phones don't allow remote volume control), and pausing on a buzz takes a moment longer.

## Troubleshooting

- **"This Spotify account isn't allowed to use this app yet"** (HTTP 403 on everything): while the Spotify app is in Development Mode, only its owner and accounts listed under *User Management* in the Spotify dashboard can use it. Add the account there.

- **Playlists from other people**: Spotify's API only lets Development Mode apps read playlists you own or collaborate on. For anyone else's *public* playlist, the game falls back to Spotify's public embed page (read through the local server), which lists the **first 100 songs**. For bigger playlists, copy the songs into a playlist of your own (*Add to other playlist → New playlist*). Private playlists from others can't be read at all.
- **Diagnostics**: the terminal running `npm start` prints what the game is doing (which song starts, what Spotify reported, loading errors).
- **"Premium is required"**: the Web Playback SDK only streams for Premium accounts.
- **No sound, or the player doesn't start**: reload the page, make sure no other tab is running the game, and try Chrome.
- **Port 8888 busy**: run `PORT=9000 npm start` and change the Redirect URI in your Spotify app to `http://127.0.0.1:9000/`.

## Files

- `server.js`: tiny static server bound to 127.0.0.1
- `public/index.html`, `public/style.css`: the beach 🏖️
- `public/app.js`: Spotify login (PKCE), playlist loading, Web Playback SDK and game logic

## Hosting it

The game runs fine on a small server behind an HTTPS reverse proxy (e.g. nginx with a Let's Encrypt certificate):

- Copy `ecosystem.config.example.js` to `ecosystem.config.js`, fill in your Spotify Client ID and log path, and start it with pm2: `pm2 start ecosystem.config.js && pm2 save`.
- Environment: `NO_OPEN=1`, `TRUST_PROXY=1` (client IPs from `X-Real-IP`), `PHONE_CONTROLLERS=1` (QR-code phone buzzers), `SPOTIFY_CLIENT_ID` (so visitors only press *Connect Spotify*), `HOST`/`PORT` for the proxy to reach.
- Add `https://<your domain>/` as a Redirect URI in the Spotify app. While it's in Development Mode, only accounts added under *User Management* in the Spotify dashboard can log in.
- Logs: one line per event, e.g. `2026-10-24T11:22:09Z INFO  session.press id=… player=1 action=buzz delivered=true`. Browser diagnostics show up as `client tab=… role=host|phone msg=…`. Session keys are never logged.
- Phone controllers: the setup screen and the player panels show one QR code per player; scanning it opens `/phone.html` as that player's buzzer. The keyboard keeps working alongside.
