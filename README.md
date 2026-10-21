# Lampa — self-hosted, without CUB

This branch (`home`) is [yumata/lampa](https://github.com/yumata/lampa) prepared for running on your own home server.
It removes everything that talks to the CUB cloud (cub.best and its mirrors), replaces the useful parts of CUB with a
small server on your own network, and adds a few playback and usability features.

- `main` is an untouched copy of upstream Lampa.
- `home` is upstream plus one commit with everything below. A daily GitHub Action rebuilds it on top of the latest
  upstream release, so upstream updates arrive automatically. See [Staying in sync with upstream](#staying-in-sync-with-upstream).

The original Lampa README (in Russian) is in upstream's repository.

## What is different from the original

### Privacy: CUB is gone

In the original, Lampa contacts CUB constantly, even without an account. Here none of that happens:

| Original Lampa | Here |
|---|---|
| TMDB catalog and posters go through CUB's proxy **by default**, so CUB sees everything you browse | Direct to TMDB |
| CUB account, bookmark/history/progress sync, live socket connection | Off; replaced by [home sync](#home-sync-profiles) |
| Usage counters, daily device report, watched titles reported to CUB | Off |
| Video ads (VAST prerolls and banners) | Off |
| Remote scripts loaded from CUB at start (Shots, Sport, TorrServer ads, seasonal decorations, the "Engineer" debug plugin) | Off, including any new ones upstream adds later |
| Copyright and plugin block lists downloaded from CUB | Off: the full catalog is shown |
| Extensions (plugins) | Off: none are loaded, and Settings has no Extensions entry |
| Reactions, comments, AI descriptions, CUB trailers, feed, plugin store, CUB screensaver, actor subscriptions | Off |
| "CUB" tab in search and notifications, "Change source to CUB" buttons, broadcast icon | Removed |
| Images and sounds loaded from GitHub | Served by your own server |

On top of the settings and patches, the server sends a **Content-Security-Policy**: the browser itself refuses to
contact anything except your server, TMDB, your TorrServer and YouTube (trailers). If an upstream update adds a new
CUB call, it is blocked before anyone notices.

Still external, because Lampa needs them: TMDB (catalog, posters), YouTube (only when you play a trailer). TorrServer
and Jackett talk to torrent trackers and peers as usual.

### Home sync (profiles)

CUB's account sync is replaced by your own server:

- **Per-person profiles**: favorites, history, watch progress, the torrent last played per title and personal settings
  are stored on your server, one JSON file per profile. Settings follow the person too: interface, TMDB, audio and
  subtitle languages, Fix browser audio, catalog source and start page, card display, the side menu's order and hidden
  items, which home rows are shown (Settings → Channels) and torrent search language. Settings that depend on the
  device stay on it: player, TorrServer, parser and its keys, screen size, performance and theme options, navigation,
  screensaver, subtitle looks, parental control. The list is `PROFILE_PREFS` in `common.js`.
- Pick a profile on first start ("Who is watching?"); switch any time with the round icon in the header, or Settings → Profile.
- Edits from several devices merge instead of overwriting each other. A device's existing favorites merge into the first profile it picks.
- No login: anyone on your network can open any profile. Keep the port on your LAN.

### Playback

- **Browser audio fix**: browsers cannot play DTS or TrueHD audio (Chrome, Brave and Firefox not even Dolby AC3/EAC3)
  and only ever play a file's default audio track. When Lampa's own player would hit that, the server streams the
  video untouched with the right audio track converted to AAC (ffmpeg). The track is chosen by your audio language
  priority. Seeking within what is loaded is instant; jumping further (or resuming) restarts the conversion (1–3 s) at the
  nearest keyframe before that point, with audio and video starting together so they stay in sync. Not used for
  Safari/iPhone (use VLC or Infuse there) or when an outside player is chosen, since those decode everything.
  Settings → Profile → Fix browser audio.
- **Play best**: a row on top of every torrent list picks the release most likely to play on this device (it asks the
  browser what it can decode: HEVC, Dolby, MKV) in your preferred audio language, then by quality and seeders. CAM
  and dead torrents lose. Settings → Profile → 1st, 2nd and 3rd audio language.
- **Episode picker**: series torrent lists get an "Episode" row. It lists seasons first; a season opens into "All of
  season 2", its packs and its episodes. Pick `S2E7` and only its releases (plus season packs containing it) remain;
  Play best then prefers that exact episode over packs.
- **Outside players open on the click** (IINA, mpv, Infuse, VLC...). The original first waited for TorrServer to
  preload, after which browsers silently blocked opening the app.
- **Play goes straight to torrents** when it is the only source (the original shows a one-item "Source" menu).
- **Continue watching**: a title you started gets a "Continue watching" button. It plays the last episode (or movie)
  you played from where you stopped, or the next episode once that one is over 90% watched. It reopens the same torrent
  and starts the right file, with the whole season queued for autoplay; if the episode is not in that torrent, it opens
  the torrent search already narrowed to it. Cards with progress show the episode (`S5 E14`) and a progress bar, in
  the home row (renamed from "Continue browsing" to "Continue watching"), History and everywhere else.
  Only the torrent's hash and trackers are kept, never a parser's download link.

### Devices

- **Send to device** (replaces CUB's broadcast): on a movie page, ⋯ → Send to device opens it on another device; long-press
  a torrent file → Play on another device starts it there. Works through your server. Name devices in Settings → Other → Device name.
- **Android browsers**: torrents play without the "install the APK" block, and Settings → Player offers VLC, MX Player,
  mpv, Just Player or Android's "Open with" list.
- **New-episode alerts**: series in your favorites that got new episodes in the last 14 days appear in the bell, one alert
  per series per release day ("10 new episodes · S2E1–E10"), per profile. The bell shows no tab bar unless there is more than one source.

### Screen and input

- **Ultrawide screens**: the layout is sized from a 16:9 width, so 21:9 monitors no longer get oversized cards.
- **Mouse and trackpad**: the wheel scrolls the page wherever the mouse is, a sideways swipe or Shift+wheel scrolls a row,
  and the amount follows the wheel. The original decided by which half of the screen the mouse was on and jumped a fixed
  distance at most every 200 ms.

### Defaults

`defaults.js` fills these only when a browser has no value yet, so your own changes in Settings stay:
TMDB proxy off, English interface, small interface size, menu always visible, parser through TorrServer (torznab,
30 s timeout), TorrServer address from the server configuration.

## Run it

Everything runs in one small container: [`selfhost/server.py`](selfhost/server.py) (Python standard library) serves
the app, home sync, send-to-device and the audio fix. The image `ghcr.io/casualsharper/lampa-home` is just Python
and ffmpeg ([`selfhost/Dockerfile`](selfhost/Dockerfile)); the code comes from this folder.

1. Put the `home` branch where the container can read it:
   ```bash
   git clone -b home https://github.com/casualsharper/lampa /volume1/docker/lampa
   ```
   (Or download the branch as a ZIP and copy the files there.)
2. Create the profile folder, writable by uid 1000 (git ignores it and the server never serves it; back it up):
   ```bash
   sudo mkdir -p /volume1/docker/lampa/data && sudo chown 1000:1000 /volume1/docker/lampa/data
   ```
3. Add the service from [`selfhost/docker-compose.example.yml`](selfhost/docker-compose.example.yml) and set
   `TORRSERVER` to your TorrServer address (`host:port`). It never appears in the code: the server hands it to Lampa.
4. Open `http://<server>:8080`. To keep the files current, pull daily:
   ```bash
   git -C /volume1/docker/lampa pull --ff-only
   ```

The container runs as a normal user, read-only, without Linux capabilities. Only the `data` folder is writable.
If it is not writable, the log says so at start and Lampa shows "Home sync can't save".

## Files

| File | What it is |
|---|---|
| `defaults.js` | CUB switches and default settings |
| `common.js` | Shared helpers (TorrServer check, language priority) |
| `homesync.js` | Profiles and sync with the server; header profile icon |
| `torrents.js` | Play best and the episode picker |
| `episodes.js` | New-episode alerts |
| `cast.js` | Send to device |
| `audiofix.js` | Browser audio fix (client side) |
| `continue.js` | Continue watching button and progress badges on cards |
| `selfhost/server.py` | The server: app files, allowlist, home sync, send-to-device, audio fix |
| `selfhost/patch.py` | All changes to Lampa's own `app.min.js` and `index.html`, re-applied to each upstream release |
| `selfhost/test_*.py`, `selfhost/test_*.js` | Tests (run by the daily job) |
| `selfhost/Dockerfile`, `.github/workflows/image.yml` | The `lampa-home` image (Python + ffmpeg), rebuilt weekly |
| `.github/workflows/sync-upstream.yml` | Daily rebuild of this branch from upstream |

## Staying in sync with upstream

Every day `.github/workflows/sync-upstream.yml` takes the latest `yumata/lampa`, adds the files above, runs
`selfhost/patch.py` on Lampa's code, checks syntax, runs all tests, and commits to `home` only if something changed.

`patch.py` finds each spot by pattern and stops if any patch does not match exactly once. So if upstream changes code
a patch relies on, the run fails (GitHub emails the owner), names the patch, and `home` stays on the last good build.
Fix the pattern in `selfhost/patch.py` and push; that re-runs the sync.
