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
  tautulli_recent/            — "Recently Watched" — list of last N watch sessions
    widget.compose.json
    api.js
    public/index.html
    preview-light.png / preview-dark.png  ← placeholders, replace before publish
  tautulli_nowplaying/        — "Now Playing" — active streams with poster + stream detail
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

**Authentication:** Single API key as a query parameter — no OAuth needed.

```
GET /api/v2?apikey=<key>&cmd=<command>[&param=value...]
```

**Response envelope:**
```json
{
  "response": {
    "result": "success",
    "message": null,
    "data": { ... }
  }
}
```

**Key commands used by this app:**

| Command | Purpose |
|---|---|
| `get_activity` | Current PMS streaming sessions (real-time) |
| `get_history` | Viewing history with filters (user, date, media type) |
| `get_plays_by_date` | Play counts grouped by date — used for `plays_today` / `plays_this_week` |
| `pms_image_proxy` | Proxy a Plex image through Tautulli — returns raw image bytes (not JSON envelope) |
| `get_home_stats` | Dashboard statistics |
| `get_users` | List Plex users |

**`get_activity` response** includes per-session: `session_key`, `user`, `friendly_name`, `title`, `full_title`, `grandparent_title`, `grandparent_thumb`, `thumb`, `media_type`, `state` (playing/paused/buffering), `progress_percent`, `transcode_decision`, `quality`, `player`, `product`, `ip_address`, `location`, `bandwidth`, `video_decision`, `audio_decision`, `stream_video_codec`, `stream_audio_codec`, etc.

**`pms_image_proxy`** returns raw image bytes — not wrapped in the API JSON envelope. Used server-side (`TautulliClient.getImageBase64`) to produce base64 data URLs for widgets. Do NOT use this as a direct `<img src>` from the widget — Homey's dashboard is HTTPS, Tautulli is HTTP; mixed content is blocked.

**Polling:** Tautulli has no push/webhook support — use interval polling. Default: 15 s (configurable 5–300 s).

**History deduplication:** `_seenHistoryIds` Set. On first poll, all IDs are pre-populated silently except records within the last 5 minutes (which fire `watch_completed`).

## Driver design

**One Homey device = one Tautulli server.** Pairing collects a single **Host URL** (e.g. `http://192.168.1.100:8181`) + API key. Device settings store `url`, `apiKey`, `pollInterval`.

**No user filtering on trigger cards.** Homey always requires `args` fields to be filled in — optional text args (leave blank for all) do not work. Triggers fire for all users; per-user filtering is done with a Logic condition on the `user` token.

**Session tracking:** `_prevSessions` `Map<session_key, session>`. Between polls: new keys → `stream_started`, removed keys → `stream_ended`, state changes → `stream_paused`/`stream_resumed`. `null` on first poll — no triggers fire on startup.

**Flow card registration** is in `driver.js onInit()`. Trigger handles stored as `this.driver._xyzTrigger`, called from `device.js`. Conditions use `getConditionCard` (not `getDeviceConditionCard` — that method does not exist).

**Flow cards** for a driver go in `drivers/tautulli/driver.flow.compose.json`. Putting them in `.homeycompose/flow/triggers/` makes them app-level global triggers — they won't appear under the device in the flow editor.

**Capabilities on the device card:**
- `alarm_generic` (`false`=idle, `true`=active) — renamed "Plex in use"
- `active_streams` (number) — current stream count
- `transcoding_streams` (number) — transcoding stream count
- `plays_today` (number) — from `get_plays_by_date`, last entry in series data
- `plays_this_week` (number) — sum of last 7 days from `get_plays_by_date`

**Thumbnail cache:** `_thumbCache` `Map<imgPath, dataUrl>` on the device. Each unique Plex image path is fetched from Tautulli once and cached as a base64 data URL for the widget.

## Widgets

### tautulli_recent — Recently Watched
- Calls `device.getRecentHistory(count)` via `api.js`
- Shows last N watch sessions grouped by day with badge, title, user, completion %
- Refreshes every 60 s

### tautulli_nowplaying — Now Playing
- Calls `device.getNowPlaying()` via `api.js`
- Shows active streams with poster (base64 data URL), user, title, progress bar, state icon
- Optional sections (toggleable in widget settings): **Client** (product/player), **Stream** (quality/decision/container), **Media** (video/audio/subtitle), **Network** (location/bandwidth, off by default)
- Refreshes every 15 s
- Poster images fetched server-side via `TautulliClient.getImageBase64` and cached — avoids mixed-content block from HTTPS dashboard → HTTP Tautulli

## Homey-specific rules

- **`brandColor`** — use `brandColor` in `app.json`, not `color`.
- **Spacing variables** — always use `--homey-su-N` (1 unit = 4 px) in widget CSS. Never hardcode px for padding/margin.
- **App/driver icon** — `fill="currentColor"` as an **XML attribute** on the root element or a wrapping `<g>`. `style="fill:currentColor"` leaves the icon invisible.
- **Capability `units`** — must be a non-empty string or i18n object, or omitted entirely. `"units": ""` fails validation.
- **Capability migration** — guard with `hasCapability()` in `onInit` before calling `addCapability()`.
- **Widget number settings** — always include `"step": 1` on `"type": "number"`.
- **Widget images (HTTPS → HTTP)** — widget iframes run in HTTPS context; direct `<img src="http://...">` is blocked as mixed content. Proxy images server-side and return base64 data URLs.
- **Widget dynamic height** — `Homey.setHeight(Math.ceil(el.getBoundingClientRect().bottom))`. Never use `document.body.scrollHeight`.
- **Widget device lookup** — `Homey.getDeviceIds()[0]` in HTML; `d.getId()` (method) in `api.js`.
- **Widget localStorage keys** — suffix with `deviceId` to avoid bleed between instances.

## Localization

Supported: **en**, **nl**. Always add both when adding user-visible strings.

- **Manifest strings** (flow titles, capability labels, driver name) — inline `{ "en": "...", "nl": "..." }` in JSON compose files.
- **Runtime strings** — `Homey.__('key')` in JS/HTML; defined in `locales/en.json` and `locales/nl.json`.

## Publishing

```bash
homey app validate --level publish   # Run before publish
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

**`README.txt`** — app store description (plain text, section headers separated by `---`). Not yet written.
