# Tautulli for Homey — User Guide

## Table of contents

1. [What this app does](#what-this-app-does)
2. [Requirements](#requirements)
3. [Installation & pairing](#installation--pairing)
4. [Device card](#device-card)
5. [Device settings](#device-settings)
6. [Flow cards](#flow-cards)
7. [Dashboard widgets](#dashboard-widgets)
8. [How images work](#how-images-work)
9. [Troubleshooting](#troubleshooting)

---

## What this app does

This app connects Homey to [Tautulli](https://tautulli.com), the monitoring and statistics tool for Plex Media Server. Once paired, your Tautulli instance appears as a device in Homey. Homey polls it every 15 seconds to track active streams and periodically for play statistics.

You can use this to:
- Turn lights on/off when someone starts or stops watching Plex
- Send notifications when specific users start a stream or finish watching something
- Display live "now playing" information and play statistics on your Homey dashboard
- Drive Insights charts for daily and weekly Plex usage

Multiple Tautulli servers are supported — pair each one as a separate Homey device.

---

## Requirements

- **Tautulli v2.x** running on your local network, reachable from Homey
- **Plex Media Server** connected to Tautulli
- **Homey Pro** (local platform required)

Tautulli does not need to be exposed to the internet. A local IP address is fine.

---

## Installation & pairing

1. In Tautulli, go to **Settings → Web Interface** and copy your **API key**.
2. In Homey, go to **Devices → Add device → Tautulli**.
3. Enter the full URL including port, for example: `http://192.168.1.100:8181`
   - Use `https://` if your Tautulli is behind a reverse proxy with TLS
   - Include a path if Tautulli is hosted under a subpath: `http://192.168.1.100:8181/tautulli`
4. Paste your API key.
5. Press **Test connection**. A green confirmation appears on success.
6. Press **Next** → **Add device**.

---

## Device card

The device shows the active stream count directly on its tile in the Homey devices overview — no need to tap into it. All values update on every poll.

| Capability | Tile | Description |
|---|---|---|
| **Active Streams** | ✓ shown on tile | Number of currently active Plex sessions |
| **Plex Active** | — | "Active" when streams are playing, "Idle" when not |
| **Transcoding Streams** | — | Number of sessions being transcoded in real time |
| **Plays Today** | — | Total plays recorded by Tautulli for today |
| **Plays This Week** | — | Total plays for the last 7 days |

**Plays Today** and **Plays This Week** are automatically logged to Homey Insights, giving you long-term usage charts.

---

## Device settings

| Setting | Default | Description |
|---|---|---|
| **Host URL** | — | Full URL to Tautulli, e.g. `http://192.168.1.100:8181` |
| **API Key** | — | Found in Tautulli → Settings → Web Interface |
| **Poll interval** | 15 s | How often Homey checks Tautulli. Range: 5–300 s |

Changes to Host URL or API Key take effect immediately without repairing. Changing the poll interval restarts the polling timer.

---

## Insights

Homey Insights records a value every time a capability changes and stores it as a time-series chart. The following capabilities feed Insights automatically — no configuration needed.

| Capability | Type | What it records |
|---|---|---|
| **Plex Active** | Boolean | Every transition between idle and active |
| **Active Streams** | Number | Stream count each time it changes |
| **Transcoding Streams** | Number | Transcoding count each time it changes |
| **Plays Today** | Number | Today's total play count, updated every poll |
| **Plays This Week** | Number | 7-day total play count, updated every poll |

**Viewing Insights**
Open the Homey app → tap your Tautulli device → tap any capability value → tap the graph icon. You can zoom the timeline and switch between hours, days, and weeks.

**What the charts show**

- *Plex in use* gives a binary on/off timeline — useful for seeing at a glance when your household watches Plex during the day or week.
- *Active / Transcoding Streams* show the exact count over time, so you can spot peak viewing hours or notice when transcoding load is high.
- *Plays Today* resets at midnight and climbs through the day. Because Homey logs every value change, the Insights chart shows the running total as a staircase — each step is one completed play.
- *Plays This Week* similarly climbs over the week and resets on a rolling 7-day window.

**A note on backfill**
Homey Insights only records data from the moment the device is first paired. There is no way to import historical Tautulli data into Insights retroactively — Homey's API does not support writing past-dated entries. The Tautulli history is surfaced instead through the **Recently Played** and **Top Stats** dashboard widgets, which query Tautulli directly and always show real historical data regardless of when the device was added.

---

## Flow cards

### Triggers (When…)

All stream triggers fire for **every user** by default. To filter by user, add a **Logic → Text tag [User] is equal to** condition after the trigger.

---

#### A stream started

Fires when a new Plex session appears.

| Token | Type | Description |
|---|---|---|
| User | Text | Plex username |
| Title | Text | Full title (e.g. "Breaking Bad - Pilot" or "Inception") |
| Media type | Text | `movie`, `episode`, or `track` |
| Player | Text | Plex client name (e.g. "Plex Web", "iPhone") |
| Transcoding | Yes/No | `true` if the stream is being transcoded |
| Season | Number | Season number for TV episodes; 0 for movies and music |
| Episode number | Number | Episode number for TV; 0 for movies and music |
| Track number | Number | Track number for music; 0 for movies and TV |

---

#### A stream ended

Fires when a Plex session disappears (user stops, changes content, or disconnects).

| Token | Type | Description |
|---|---|---|
| User | Text | Plex username |
| Title | Text | Full title |
| Media type | Text | `movie`, `episode`, or `track` |
| Progress (%) | Number | How far through the content the stream got |
| Season | Number | Season number (0 if not TV) |
| Episode number | Number | Episode number (0 if not TV) |
| Track number | Number | Track number (0 if not music) |

---

#### A stream was paused / A stream was resumed

Fires when an existing session changes state from playing → paused or paused → playing.

| Token | Type | Description |
|---|---|---|
| User | Text | Plex username |
| Title | Text | Full title |
| Media type | Text | `movie`, `episode`, or `track` |
| Player | Text | Plex client name |
| Season | Number | Season number (0 if not TV) |
| Episode number | Number | Episode number (0 if not TV) |
| Track number | Number | Track number (0 if not music) |

---

#### A watch session completed

Fires when a completed play record appears in Tautulli's history. This is different from "stream ended" — Tautulli only records a history entry once the session fully closes and is logged.

On startup, Homey silently pre-populates the last 25 history records so old items don't re-fire after a restart. Records completed in the last 5 minutes before a restart **do** re-fire, to avoid missing recent watches.

| Token | Type | Description |
|---|---|---|
| User | Text | Plex username |
| Title | Text | Full title |
| Media type | Text | `movie`, `episode`, or `track` |
| Progress (%) | Number | Completion percentage |
| Duration (s) | Number | Total duration of the media in seconds |
| Season | Number | Season number (0 if not TV) |
| Episode number | Number | Episode number (0 if not TV) |
| Track number | Number | Track number (0 if not music) |

**Tip:** Use Progress (%) in a Logic condition (e.g. `>= 80`) to only trigger when content was actually watched through.

---

#### Active stream count changed

Fires whenever the total number of active streams changes in either direction.

| Token | Type | Description |
|---|---|---|
| Active streams | Number | New stream count |
| Previous count | Number | Previous stream count |

---

### Conditions (And…)

#### Active streams is/is not above [N]

Checks the current number of active Plex streams against a threshold. Useful as a guard condition so automations don't fire when Plex is idle.

Example: "Turn off the living room lights AND active streams is not above 0" — ensures lights only go off when no one is watching anywhere in the house.

---

## Dashboard widgets

### Now Playing

Shows every active Plex stream in real time. Refreshes every 15 seconds.

Each stream card shows:
- **User avatar** + username
- **Media type badge** (Movie / TV / Music)
- **State icon** (▶ playing, ⏸ paused, ↻ buffering)
- **Full title** of what's playing
- **Progress bar** with percentage

**Optional sections** (toggle each on/off in widget settings):

| Section | Contents |
|---|---|
| Client | Product (e.g. Plex Web) and Player (e.g. Chrome) |
| Stream | Quality, stream decision (Direct Play / Transcode), container conversion |
| Media | Video codec path, audio codec path, subtitle |
| Network | Location (LAN/WAN + IP address), bandwidth |

Network is off by default. When nothing is playing, a "Nothing is playing" notice is shown.

**Settings:**
- Show poster (on by default) — content poster on the left of each card
- Show widget title
- Show/hide each section individually

---

### Recently Played

A list of the last N items played across all media types, grouped by day. Refreshes every 60 seconds.

Each item shows the media type badge, title, username, and completion percentage.

**Settings:**
- Number of items (1–25, default 10)
- Group by day (on by default)
- Show widget title

---

### Top Stats

Ranked leaderboards, each with a poster/avatar/icon for the #1 item. Refreshes every 5 minutes.

| Section | Image | Description |
|---|---|---|
| Most Watched Movies | Portrait poster | Movies ordered by play count |
| Most Watched TV Shows | Portrait poster | Shows ordered by play count |
| Most Played Artists | Cover art | Music artists ordered by play count |
| Most Active Users | Circular avatar | Users ordered by total plays |
| Most Active Platforms | Platform icon | Plex clients ordered by total plays |

**Settings:**
- Time range: Last 7 / 30 / 90 days (default 30)
- Items per section: 3–10 (default 5)
- Show poster for #1
- Show/hide each section individually

**Multiple widgets tip:** If you create one widget per category with all other sections hidden, data is still only fetched once per minute per device — results are cached on the device for 60 seconds.

---

## How images work

All images (posters, user avatars, platform icons) are fetched server-side by Homey and delivered to widgets as embedded data. They are never loaded directly by the browser, which avoids mixed-content blocking when Homey's dashboard is served over HTTPS and Tautulli runs on plain HTTP.

**Posters and user avatars** are fetched through Tautulli's `pms_image_proxy` API command, which handles Plex authentication automatically.

**Platform icons** are first attempted from your local Tautulli server. If that is blocked (Tautulli's web UI requires a login session for static files), they fall back to the public Tautulli GitHub repository.

All images are cached in memory on the device for the lifetime of the app session. Platform icons are essentially permanent once loaded; Plex media images are cached until the app restarts.

---

## Troubleshooting

**Device shows "unavailable"**
Homey cannot reach Tautulli. Check that the Host URL is correct and that Tautulli is running. The full URL including port is required (e.g. `http://192.168.1.100:8181`).

**Flow triggers don't fire**
Confirm the device is available (green in Homey). Triggers only fire after the first successful poll — nothing fires on startup to avoid false events after a restart.

**"A watch session completed" fires for old items after restart**
By design, items completed in the last 5 minutes before a restart are re-fired. Items older than 5 minutes are silently ignored. You can avoid duplicate automations by making your flow action idempotent (e.g. "turn on light" rather than "toggle light").

**Widgets show a placeholder for images**
This is normal on first load — images are fetched server-side and cached. They appear within a few seconds of the widget first loading. If they never appear, check that Tautulli is reachable from Homey.

**Platform icons don't load**
If your Tautulli has web authentication enabled, Homey falls back to fetching platform icons from Tautulli's GitHub repository. This requires Homey to have internet access. If both fail, the icon column shows a grey placeholder.

**Plays Today / Plays This Week show 0**
These are populated from `get_plays_by_date`. If Tautulli has no history for the current period (e.g. freshly installed), they will be 0 until plays are recorded.
