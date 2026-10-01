# Advanced Playlist — IINA plugin

A full-featured music playlist for IINA, in the spirit of desktop music players.
Each row shows **artist · album** and the **track name**, with **search**,
**sorting**, **drag-to-reorder** and **save / load** of named playlists. It runs
both as a sidebar tab and as a **detachable, freely resizable window**.

This is the pure-plugin approach ("Variant A"): it does **not** modify IINA's
source. It adds a tab to the built-in **Plugins** sidebar, so the existing
"Plugins" OSC toolbar button (or the *Show Advanced Playlist* menu item / `⌘⇧E`)
opens it.

## Features

- **Metadata rows** — `artist · album` above, track name below, plus duration.
- **Transport bar** — play/pause, previous/next, **repeat** (off → whole
  playlist → one track, via `loop-playlist`/`loop-file`) and **shuffle**
  (`playlist-shuffle` / `playlist-unshuffle`). Reflects state changed elsewhere.
- **Seek bar** — current / total time; click or drag to seek (`core.seekTo`).
- **Configurable hotkeys** — set keys for play/pause, previous, next and
  seek ±10s on the plugin's **Preferences** page. They work inside IINA: in the
  **main player window** (via `iina.input`) and in the **playlist window/sidebar**.
  Not system-wide (a plugin can't grab keys while IINA is in the background).
  Defaults: `X` play/pause, `Z` previous, `C` next.
- **Search** — live filter across title / artist / album / path.
- **Sort** — by playlist order, title, artist, album or duration (asc/desc).
- **Reorder** — drag rows (only in "Playlist order" view) → `playlist.move`.
- **Play** — double-click or `Enter`; now-playing row is highlighted.
- **Selection** — click, `⌘`-click (toggle), `⇧`-click (range), `⌘A` (all).
- **Remove** — `⌫`/`Delete` or context menu (multi-select supported).
- **Add files** — native open panel → appended to the playlist.
- **YouTube Music search** (`🎵`) — search songs without leaving the playlist;
  results show cover, artist · album, duration and play count (`▶ 2.3B`). `＋` / `↩` / double-click
  appends a song, `Next` / `⇧↩` inserts it right after the current track,
  `＋ All` appends every result, `Esc` returns to the playlist. See
  [YouTube Music search](#youtube-music-search) below.
- **Save / Save As** — the Save dialog opens with the name of the playlist the
  current list came from: keep it to update that playlist, type another name to
  store a copy (which then becomes the active one). The dialog states up front
  whether it will update, overwrite or create.
- **Load** — playlists are stored as `.m3u8` in the plugin's private `@data`
  folder; loading uses mpv's `loadlist`. External `.m3u/.m3u8/.pls` can be
  imported via **Load → Import file…**.
- **Auto-save** (optional, **Preferences → Playlists**) — every change to the
  playlist (add, remove, reorder, sort) is written back to the playlist that was
  last **saved** or **loaded** in that window; the footer shows `⟳ <name>` while
  it is armed. Imported external files are not auto-saved; an empty playlist, or
  one replaced by an unrelated file, never overwrites the saved one (auto-saving
  simply disarms).
- **Reopen at launch** (on by default, **Preferences → Playlists**) — the
  playlist last saved or loaded (in any window) is reopened when IINA is
  launched on its own. Launching IINA to open a file leaves that file alone;
  deleting the remembered playlist forgets it.
- **Show on open** (**Preferences → Playlists**, sidebar by default) — when a
  player window opens, the playlist is shown in its sidebar or in the separate
  window (or not at all). It happens once per player, after its first track
  loads, since the player window only appears then. In music mode (IINA's
  default for audio) the main window and its sidebar are hidden, so the
  separate window is opened instead.
- **Start paused** (on by default, **Preferences → Playlists**) — loading or
  importing a playlist, or opening an `.m3u/.m3u8/.pls` file in IINA (Finder,
  *File → Open*, at launch), selects the first track without playing it. mpv
  starts the first entry and IINA resumes playback once it is loaded, so the
  plugin pauses before the load and undoes that one automatic resume. How long
  it watches for that resume after the track loads is configurable
  (0.5–10 s, default 1 s) — raise it if video or online tracks still start.
- **Reveal in Finder** — from the row context menu.
- **Detachable window** (`⤢`) — the same playlist in a native window that is
  freely resizable by the mouse; the size is remembered between sessions.
- **Hide player** (`🖥`, window only) — minimizes the main player window so only
  the playlist stays on screen (the plugin API can't set an always-on-top level,
  so hiding the player is used instead). It is restored when the window closes.

## How metadata is resolved

1. **mpv (authoritative)** — on `iina.file-loaded` the current file's
   `metadata` (and `duration`) are read via `iina.mpv` and cached.
2. **Background tag scan** — every other local file is parsed directly from its
   bytes (`iina.file.handle`) on a throttled queue: **ID3v2 / ID3v1** (MP3),
   **MP4/M4A** (`©nam/©ART/©alb`), **FLAC** and **Ogg/Opus** (Vorbis comments).
   Anything unrecognised falls back to the file name.
3. **Cache** — results persist to `@data/metadata-cache.json`, so re-opening is
   instant.

### Known limitations

- Duration is only known for files IINA has actually loaded (mpv reports it);
  un-played rows show a blank duration.
- Matroska/WebM tags (EBML) are not parsed — those rows use mpv metadata once
  played, otherwise the file name.
- The tag scan reads only the first ~1 KB of each text field, so cover-art is
  never loaded into memory.

## YouTube Music search

- **Source** — YouTube Music's internal (unofficial) search API, called with
  `/usr/bin/curl`: one request (~0.5 s) returns title, artist, album, duration
  and cover art. No API key or Google account is needed.
- **Fallback** — if the API fails (e.g. YouTube changed its format), the search
  goes through yt-dlp instead. Results then show titles only; artist/album are
  filled in by the usual yt-dlp enrichment once a song is added.
- **Sorting** — results keep YouTube Music's relevance order by default;
  **Preferences → YouTube Music search** can sort them by play count, most
  played first (from the next search; not available in the yt-dlp fallback,
  which has no counts).
- **Playback** — songs are added as `https://music.youtube.com/watch?v=…` URLs and
  played through IINA's youtube-dl/yt-dlp support, like any pasted URL.

### Known limitations

- The API is unofficial and may change; the client version sent with the request
  (`CLIENT_VERSION` in `ytmusic.js`) may need a bump some day.
- Only public search: your YouTube Music library, likes and playlists are not
  available (no sign-in).
- Region- or age-restricted songs may fail to play.

## Install (development)

The plugin system is enabled in this build. Symlink this folder into IINA's
plugins directory with the `.iinaplugin-dev` extension:

```sh
PLUGINS="$HOME/Library/Application Support/com.colliderli.iina/plugins"
mkdir -p "$PLUGINS"
ln -s "$(pwd)/PlaylistProPlugin" "$PLUGINS/io.iina.playlist-pro.iinaplugin-dev"
```

> The app-support directory depends on the running app's bundle id; for a
> locally-built IINA it may differ from `com.colliderli.iina`. Adjust the path
> to match your build.

Then launch IINA, open **Settings → Plugins**, and make sure *Advanced Playlist*
is enabled. Play any file, open the **Plugins** sidebar (toolbar puzzle-piece
button or *Show Advanced Playlist* / `⌘⇧E`) and pick the **Advanced Playlist**
tab. Press `⤢` to detach it into a resizable window.

To ship it as a normal plugin instead, rename the folder to
`io.iina.playlist-pro.iinaplugin` and drop it (not a symlink) into `plugins/`.

> The plugin identifier stays `io.iina.playlist-pro` after the rename, so the
> existing dev symlink and the saved playlists/metadata cache under
> `plugins/.data/io.iina.playlist-pro/` keep working.

## Files

| File                  | Role                                                        |
|-----------------------|-------------------------------------------------------------|
| `Info.json`           | Manifest: sidebar tab, preferences page, permissions.       |
| `main.js`             | Backend (per-window): playlist, tags, cache, hotkeys, I/O.  |
| `ytmusic.js`          | YouTube Music song search (API + yt-dlp fallback).          |
| `ui/index.html`       | Self-contained playlist UI (inline CSS+JS).                 |
| `ui/preferences.html` | Preferences: hotkeys, auto-save, yt-dlp path.               |

The UI is a single self-contained HTML file because the sidebar `WKWebView`
loads a `file://` URL without read access to sibling files.
