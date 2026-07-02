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
- **Save / Load** — playlists are stored as `.m3u8` in the plugin's private
  `@data` folder; loading uses mpv's `loadlist`. External `.m3u/.m3u8/.pls`
  can be imported via **Load → Import file…**.
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
| `ui/index.html`       | Self-contained playlist UI (inline CSS+JS).                 |
| `ui/preferences.html` | Hotkey configuration page (key recorder).                   |

The UI is a single self-contained HTML file because the sidebar `WKWebView`
loads a `file://` URL without read access to sibling files.
