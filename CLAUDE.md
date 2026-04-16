# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [Homey](https://homey.app) smart home app (SDK v3, Node.js) that integrates [Tautulli](https://tautulli.com) — a monitoring and tracking tool for Plex Media Server. App ID: `net.ladenius.tautuli`.

## Commands

```bash
npm run lint                      # ESLint (athom/homey-app rules)
homey app run                     # Run app on a connected Homey device
homey app build                   # Compose .homeycompose/ → root app.json + drivers/
homey app validate --level publish # Full publish-level validation (catches asset requirements)
homey app publish                 # Publish to Homey App Store
```

Install Homey CLI globally if not present: `npm install -g homey`.

## Project structure

```
app.js                        — App entry point (extends Homey.App)
lib/
  TautulliClient.js           — HTTP client for the Tautulli API
drivers/
  tautulli/
    driver.js                 — Extends Homey.Driver; registers flow cards + handles pairing
    driver.compose.json       — Device class, capabilities, settings, pair steps
    driver.flow.compose.json  — All device-scoped flow triggers + conditions ← driver-level, NOT .homeycompose/flow/
    device.js                 — Extends Homey.Device; polling, session tracking, history dedup, widget API
    pair/
      connect.html            — Custom pair UI (single URL field + API key)
    assets/
      icon.svg                — Driver/device icon (Tautulli logo, fill="currentColor")
      images/                 — small.png (75×75), large.png (500×500)  ← must add before publish
.homeycompose/
  app.json                    — App metadata (id, version, brandColor: #e5a00d)
  capabilities/
    active_streams.json
    transcoding_streams.json
    plays_today.json
    plays_this_week.json
assets/
  icon.svg                    — App icon (Tautulli logo, fill="currentColor")
  images/                     — small.png, large.png, xlarge.png  ← must add before publish
widgets/
  tautulli_recent/            — "Recently Played" — last N play sessions (movies/TV/music)
    widget.compose.json
    api.js
    public/index.html
    preview-light.png / preview-dark.png  ← placeholders, replace before publish
  tautulli_nowplaying/        — "Now Playing" — active streams with poster + stream detail
    widget.compose.json
    api.js
    public/index.html
    preview-light.png / preview-dark.png  ← placeholders, replace before publish
  tautulli_topstats/          — "Top Stats" — ranked lists per category with poster/avatar/icon for #1
    widget.compose.json
    api.js
    public/index.html
    preview-light.png / preview-dark.png  ← placeholders, replace before publish
locales/
  en.json                     — Strings for Homey.__('key') in JS/HTML
  nl.json                     — Dutch translations
.eslintrc.json                — Extends athom/homey-app
tsconfig.json                 — Needed by the TS ESLint parser; covers app.js, lib/, drivers/, widgets/
```

`app.json` at the repo root is **auto-generated** — never edit it directly. Always edit `.homeycompose/app.json`.

## Tautulli API

**Base URL:** `http://<host>:<port>/api/v2`

**Authentication:** API key as query parameter — works for `/api/v2` only. Static files at `/images/` require a session cookie (browser login) — the API key is NOT accepted there.

```
GET /api/v2?apikey=<key>&cmd=<command>[&param=value...]
```

**Response envelope:**
```json
{ "response": { "result": "success", "message": null, "data": { ... } } }
```

**Key commands used by this app:**

| Command | Purpose |
|---|---|
| `get_activity` | Current PMS streaming sessions (real-time) |
| `get_history` | Viewing history with filters (user, date, media type) |
| `get_plays_by_date` | Play counts grouped by date — used for `plays_today` / `plays_this_week` |
| `pms_image_proxy` | Proxy a Plex image — returns raw image bytes, not JSON envelope |
| `get_home_stats` | Top lists (top_movies, top_tv, top_music, top_users, top_platforms) |
| `get_users` | List Plex users |

**`get_activity` session fields:** `session_key`, `user`, `friendly_name`, `user_thumb`, `title`, `full_title`, `grandparent_title`, `grandparent_thumb`, `thumb`, `parent_thumb`, `media_type`, `state` (playing/paused/buffering), `progress_percent`, `transcode_decision`, `quality`, `player`, `product`, `platform`, `platform_name`, `ip_address`, `location`, `bandwidth`, `video_decision`, `audio_decision`, `stream_video_codec`, `stream_audio_codec`, `stream_audio_channels`, `stream_container`, `stream_video_resolution`, `subtitle_codec`, `throttled`.

**`get_home_stats` platform rows:** `platform` (display name), `platform_name` (lowercase slug, e.g. `"chrome"`), `total_plays`. No `platform_image` field — derive icon path as `platforms/{platform_name}.svg`.

**`pms_image_proxy`** returns raw image bytes. Also accepts external URLs (e.g. Plex CDN user avatar URLs) as the `img` parameter — Tautulli fetches and proxies them.

**Platform icons** are at `/images/platforms/{name}.svg` on the Tautulli server, but that path requires a session cookie (401 with API key). Fallback: fetch from `https://raw.githubusercontent.com/Tautulli/Tautulli/master/data/interfaces/default/images/platforms/{name}.svg` which is public.

**Polling:** No push/webhook support — use interval polling. Default: 15 s (configurable 5–300 s).

**History deduplication:** `_seenHistoryIds` Set. On first poll, all IDs are pre-populated silently except records within the last 5 minutes (which fire `watch_completed`).

## Driver design

**One Homey device = one Tautulli server.** Pairing collects a single **Host URL** (e.g. `http://192.168.1.100:8181`) + API key. Device settings: `url`, `apiKey`, `pollInterval`.

**No user filtering on trigger cards.** Homey always requires `args` fields — optional text args don't work. Triggers fire for all users; filter with a Logic condition on the `user` token.

**Session tracking:** `_prevSessions` `Map<session_key, session>`. Between polls: new keys → `stream_started`, removed → `stream_ended`, state changes → `stream_paused`/`stream_resumed`. `null` on first poll — no triggers fire on startup.

**Flow card registration** in `driver.js onInit()`. Conditions use `getConditionCard` (not `getDeviceConditionCard` — that method does not exist).

**Flow cards** go in `drivers/tautulli/driver.flow.compose.json` — NOT in `.homeycompose/flow/`. The latter creates app-level global triggers that don't appear under the device in the flow editor.

**Capabilities on the device card:**
- `alarm_generic` (`false`=idle, `true`=active) — renamed "Plex in use"
- `active_streams` (number)
- `transcoding_streams` (number)
- `plays_today` (number) — last entry in `get_plays_by_date` series data
- `plays_this_week` (number) — 7-day sum from `get_plays_by_date`

**Device-level caches (all in-memory, reset on restart):**

| Property | Type | Purpose |
|---|---|---|
| `_thumbCache` | `Map<path, dataUrl>` | Plex media images + user avatars, permanent |
| `_statsCache` | `Map<"TR:count", {data, expiresAt}>` | `getTopStats` result, 60-second TTL |

The 60-second stats cache means multiple Top Stats widgets pointing at the same device share one `get_home_stats` HTTP call per minute, regardless of how many widget instances are open.

## Widgets

### tautulli_recent — Recently Played
- `device.getRecentHistory(count)` → last N history records
- Shows grouped by day: badge (Movie/TV/Music), title, user, completion %
- Refreshes every 60 s

### tautulli_nowplaying — Now Playing
- `device.getNowPlaying()` → active sessions with `thumbUrl` (content poster) + `userThumbUrl` (user avatar)
- Shows: circular user avatar, username, media type badge, state icon (▶/⏸/↻), title, progress bar
- Toggleable sections: **Client**, **Stream**, **Media**, **Network** (off by default)
- Refreshes every 15 s

### tautulli_topstats — Top Stats
- `device.getTopStats({ timeRange, count })` → ranked lists for 5 categories
- Categories: top_movies, top_tv, top_music, top_users, top_platforms
- Two-column layout: image column (spans full list height) + items column
- Image styles: portrait poster (movies/TV/music), circle avatar (users), square contained icon (platforms)
- Platform icons fetched from GitHub as fallback when Tautulli auth blocks `/images/`
- Result cached 60 s per `timeRange:count` combination
- Refreshes every 5 min

## Image fetching architecture

All images returned to widgets are **base64 data URLs** embedded in the JSON response — never direct `http://` URLs. This avoids mixed-content blocking (Homey dashboard is HTTPS, Tautulli is HTTP).

| Source | Method | Cached |
|---|---|---|
| Plex media (posters, thumbs) | `TautulliClient.getImageBase64()` via `pms_image_proxy` | `_thumbCache`, permanent |
| User avatars (Plex CDN URLs) | `TautulliClient.getImageBase64()` via `pms_image_proxy` | `_thumbCache`, permanent |
| Platform icons (local) | `TautulliClient.getStaticImage()` → `/images/platforms/{name}.svg` | `_thumbCache`, permanent |
| Platform icons (fallback) | `TautulliClient.fetchImage()` → GitHub raw CDN | `_thumbCache`, permanent |

`_fetchImageBytes(lib, host, port, path)` is the shared low-level HTTP helper used by all image methods.

## Homey-specific rules

- **`brandColor`** — use `brandColor` in `app.json`, not `color`.
- **Spacing variables** — always use `--homey-su-N` (1 unit = 4 px). Never hardcode px for padding/margin.
- **App/driver icon** — `fill="currentColor"` as an **XML attribute** on root `<svg>` or wrapping `<g>`. `style="fill:currentColor"` leaves icon invisible.
- **Capability `units`** — non-empty string or i18n object, or omit entirely. `"units": ""` fails validation.
- **Capability migration** — guard with `hasCapability()` before `addCapability()`.
- **Widget number settings** — always `"step": 1` on `"type": "number"`.
- **Widget images** — always proxy server-side; never use direct `http://` URLs in `<img src>`.
- **Widget dynamic height** — `Homey.setHeight(Math.ceil(el.getBoundingClientRect().bottom))`.
- **Widget device lookup** — `Homey.getDeviceIds()[0]` in HTML; `d.getId()` in `api.js`.
- **Widget localStorage keys** — suffix with `deviceId`.
- **Widget data sharing** — multiple instances of the same widget share `_thumbCache` (permanent) and `_statsCache` (60 s TTL). The raw Tautulli API calls are NOT shared unless a cache layer is added.

## Localization

Supported: **en**, **nl**. Always add both.

- **Manifest strings** (flow titles, capability labels, driver name) — inline `{ "en": "...", "nl": "..." }` in JSON compose files.
- **Runtime strings** — `Homey.__('key')` in JS/HTML; defined in `locales/en.json` and `locales/nl.json`.

## Publishing

```bash
homey app validate --level publish
homey app publish
```

**Required assets before publish:**

| Location | File | Size |
|---|---|---|
| `assets/images/` | `small.png` | 250×175 px |
| `assets/images/` | `large.png` | 500×350 px |
| `assets/images/` | `xlarge.png` | 1000×700 px |
| `drivers/tautulli/assets/images/` | `small.png` | 75×75 px |
| `drivers/tautulli/assets/images/` | `large.png` | 500×500 px |
| `widgets/tautulli_recent/` | `preview-light.png`, `preview-dark.png` | Replace placeholders |
| `widgets/tautulli_nowplaying/` | `preview-light.png`, `preview-dark.png` | Replace placeholders |
| `widgets/tautulli_topstats/` | `preview-light.png`, `preview-dark.png` | Replace placeholders |

**`README.txt`** — app store description (plain text, section headers separated by `---`). Not yet written.
