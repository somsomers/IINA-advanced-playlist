// Advanced Playlist — backend entry (runs once per player window)
//
// Responsibilities:
//   * Bridge IINA's native playlist (iina.playlist) to a custom HTML UI in the sidebar.
//   * Resolve artist / album / title for every item:
//       1. authoritative metadata from mpv for the currently playing file;
//       2. background tag scanning (ID3v2/ID3v1, MP4, FLAC, Ogg/Opus) for the rest.
//   * Persist a metadata cache and named playlists into the plugin's @data folder.

const { playlist, mpv, event, sidebar, standaloneWindow, menu, core, file, utils, preferences, console } = iina;

// Post a message to BOTH surfaces (sidebar tab + standalone window). Posting to a
// surface whose webview isn't loaded is a harmless no-op.
function broadcast(name, data) {
  try { sidebar.postMessage(name, data); } catch (e) { }
  try { standaloneWindow.postMessage(name, data); } catch (e) { }
}

const CACHE_FILE = "@data/metadata-cache.json";
const PLAYLIST_PREFIX = "playlist_";
const PLAYLIST_EXT = ".m3u8";

const MEDIA_EXT = [
  "mp3", "m4a", "aac", "flac", "wav", "aiff", "aif", "aifc", "ogg", "oga",
  "opus", "wma", "alac", "ape", "mka", "mp4", "m4v", "mkv", "mov", "avi",
  "webm", "flv", "ts", "wmv", "mpg", "mpeg", "3gp"
];

let uiReady = false;
let metaCache = {};        // path -> { title, artist, album, duration, scanned }
let lastSignature = "";
let weMinimized = false;    // true while WE have minimized the main window
let shuffleOn = false;      // whether the playlist is currently shuffled
let lastTransportSig = "";  // to avoid re-broadcasting unchanged transport state

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function isNetwork(p) { return /^[a-z][a-z0-9+.\-]*:\/\//i.test(p); }
function baseName(p) {
  const s = String(p).replace(/[/\\]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}
function stripExt(n) { const i = n.lastIndexOf("."); return i > 0 ? n.slice(0, i) : n; }
function sanitize(name) { return String(name).replace(/[^\w\-. ]+/g, "_").slice(0, 120); }

// ---------------------------------------------------------------------------
// Byte decoders (JavaScriptCore has no TextDecoder)
// ---------------------------------------------------------------------------
function beU32(b, o) { return b[o] * 16777216 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3]; }
function u32le(b, o) { return b[o] + b[o + 1] * 256 + b[o + 2] * 65536 + b[o + 3] * 16777216; }
function syncsafe(b, o) { return b[o] * 2097152 + b[o + 1] * 16384 + b[o + 2] * 128 + b[o + 3]; }

function latin1(b, s, e) {
  let r = "";
  e = Math.min(e, b.length);
  for (let i = s; i < e; i++) r += String.fromCharCode(b[i]);
  return r;
}
function decodeLatin1(b, s, e) {
  let r = "";
  e = Math.min(e, b.length);
  for (let i = s; i < e; i++) { const c = b[i]; if (c === 0) break; r += String.fromCharCode(c); }
  return r;
}
function decodeUTF8(b, s, e) {
  let r = "";
  let i = s;
  e = Math.min(e, b.length);
  while (i < e) {
    let c = b[i++];
    if (c === 0) break;
    if (c < 0x80) { r += String.fromCharCode(c); }
    else if (c < 0xE0) { if (i >= e) break; const c2 = b[i++]; r += String.fromCharCode(((c & 0x1F) << 6) | (c2 & 0x3F)); }
    else if (c < 0xF0) { if (i + 1 >= e) break; const c2 = b[i++], c3 = b[i++]; r += String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F)); }
    else { if (i + 2 >= e) break; const c2 = b[i++], c3 = b[i++], c4 = b[i++]; let cp = ((c & 0x07) << 18) | ((c2 & 0x3F) << 12) | ((c3 & 0x3F) << 6) | (c4 & 0x3F); cp -= 0x10000; r += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); }
  }
  return r;
}
function decodeUTF16(b, s, e, be) {
  e = Math.min(e, b.length);
  let i = s, bigE = be;
  if (bigE == null) {
    if (b[i] === 0xFE && b[i + 1] === 0xFF) { bigE = true; i += 2; }
    else if (b[i] === 0xFF && b[i + 1] === 0xFE) { bigE = false; i += 2; }
    else bigE = false;
  }
  let r = "";
  for (; i + 1 < e; i += 2) {
    const u = bigE ? ((b[i] << 8) | b[i + 1]) : ((b[i + 1] << 8) | b[i]);
    if (u === 0) break;
    r += String.fromCharCode(u);
  }
  return r;
}
function cleanStr(s) { return s ? s.replace(/\x00+/g, "").trim() : ""; }

function indexOfAscii(b, str) {
  const n = str.length, L = b.length;
  for (let i = 0; i + n <= L; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) { if (b[i + j] !== str.charCodeAt(j)) { ok = false; break; } }
    if (ok) return i;
  }
  return -1;
}
function indexOfBytes(b, bytes) {
  const n = bytes.length, L = b.length;
  for (let i = 0; i + n <= L; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) { if (b[i + j] !== bytes[j]) { ok = false; break; } }
    if (ok) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Tag readers — operate directly on the file bytes via iina.file.handle
// ---------------------------------------------------------------------------
function fileSize(h) { h.seekToEnd(); const o = h.offset(); return typeof o === "number" ? o : Number(o); }

function decodeTextFrame(b, s, e) {
  if (e <= s) return "";
  const enc = b[s], p = s + 1;
  if (enc === 1) return cleanStr(decodeUTF16(b, p, e, null));
  if (enc === 2) return cleanStr(decodeUTF16(b, p, e, true));
  if (enc === 3) return cleanStr(decodeUTF8(b, p, e));
  return cleanStr(decodeLatin1(b, p, e));
}

function parseID3v2(h, head) {
  const ver = head[3], flags = head[5];
  const size = syncsafe(head, 6);
  const endTag = 10 + size;
  let pos = 10;
  if (flags & 0x40) { // extended header — skip it
    h.seekTo(10);
    const eh = h.read(4);
    if (eh && eh.length >= 4) {
      const esize = ver === 4 ? syncsafe(eh, 0) : beU32(eh, 0);
      pos = 10 + (ver === 4 ? esize : esize + 4);
    }
  }
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  const wanted = ver === 2
    ? { TT2: "title", TP1: "artist", TAL: "album", TP2: "albumartist" }
    : { TIT2: "title", TPE1: "artist", TALB: "album", TPE2: "albumartist" };
  const out = {};
  let guard = 0;
  while (pos + hdrLen <= endTag && guard++ < 512) {
    h.seekTo(pos);
    const fh = h.read(hdrLen);
    if (!fh || fh.length < hdrLen || fh[0] === 0) break; // padding / EOF
    const id = latin1(fh, 0, idLen);
    let fsize;
    if (ver === 2) fsize = fh[3] * 65536 + fh[4] * 256 + fh[5];
    else if (ver === 4) fsize = syncsafe(fh, 4);
    else fsize = beU32(fh, 4);
    if (fsize <= 0) break;
    const key = wanted[id];
    if (key && !out[key]) {
      h.seekTo(pos + hdrLen);
      const fb = h.read(Math.min(fsize, 1000));
      if (fb) out[key] = decodeTextFrame(fb, 0, fb.length);
    }
    pos += hdrLen + fsize;
  }
  return out;
}

function parseID3v1(h) {
  const size = fileSize(h);
  if (size < 128) return null;
  h.seekTo(size - 128);
  const b = h.read(128);
  if (!b || b.length < 128 || !(b[0] === 0x54 && b[1] === 0x41 && b[2] === 0x47)) return null; // 'TAG'
  return {
    title: cleanStr(decodeLatin1(b, 3, 33)),
    artist: cleanStr(decodeLatin1(b, 33, 63)),
    album: cleanStr(decodeLatin1(b, 63, 93))
  };
}

function parseVorbisComment(b, off, end) {
  try {
    let p = off;
    const vlen = u32le(b, p); p += 4 + vlen;      // vendor string
    const count = u32le(b, p); p += 4;
    const out = {};
    for (let i = 0; i < count && p + 4 <= end; i++) {
      const clen = u32le(b, p); p += 4;
      if (p + clen > end) break;
      const s = decodeUTF8(b, p, p + clen); p += clen;
      const eq = s.indexOf("=");
      if (eq > 0) {
        const k = s.slice(0, eq).toUpperCase(), v = cleanStr(s.slice(eq + 1));
        if (k === "TITLE" && !out.title) out.title = v;
        else if (k === "ARTIST" && !out.artist) out.artist = v;
        else if (k === "ALBUM" && !out.album) out.album = v;
        else if (k === "ALBUMARTIST" && !out.albumartist) out.albumartist = v;
      }
    }
    return out;
  } catch (e) { return null; }
}

function parseFlac(h) {
  let pos = 4;
  const total = fileSize(h);
  for (let n = 0; n < 64 && pos + 4 <= total; n++) {
    h.seekTo(pos);
    const bh = h.read(4);
    if (!bh || bh.length < 4) break;
    const last = (bh[0] & 0x80) !== 0;
    const type = bh[0] & 0x7F;
    const len = bh[1] * 65536 + bh[2] * 256 + bh[3];
    if (type === 4) { // VORBIS_COMMENT
      h.seekTo(pos + 4);
      const data = h.read(Math.min(len, 200000));
      return data ? parseVorbisComment(data, 0, data.length) : null;
    }
    pos = pos + 4 + len;
    if (last) break;
  }
  return null;
}

function parseOgg(h) {
  try {
    h.seekTo(0);
    const b = h.read(65536);
    if (!b) return null;
    const io = indexOfAscii(b, "OpusTags");
    if (io >= 0) return parseVorbisComment(b, io + 8, b.length);
    const iv = indexOfBytes(b, [0x03, 0x76, 0x6F, 0x72, 0x62, 0x69, 0x73]); // \x03vorbis
    if (iv >= 0) return parseVorbisComment(b, iv + 7, b.length);
    return null;
  } catch (e) { return null; }
}

function parseMp4(h) {
  const total = fileSize(h);
  function boxAt(pos) {
    if (pos + 8 > total) return null;
    h.seekTo(pos);
    const b = h.read(8);
    if (!b || b.length < 8) return null;
    let bs = beU32(b, 0), hdr = 8;
    const type = latin1(b, 4, 8);
    if (bs === 1) { const b2 = h.read(8); if (!b2 || b2.length < 8) return null; bs = beU32(b2, 0) * 4294967296 + beU32(b2, 4); hdr = 16; }
    else if (bs === 0) bs = total - pos;
    return { pos: pos, size: bs, type: type, hdr: hdr, dataStart: pos + hdr, dataEnd: pos + bs };
  }
  function findChild(start, end, names) {
    let pos = start, guard = 0;
    while (pos + 8 <= end && guard++ < 4096) {
      const box = boxAt(pos);
      if (!box || box.size < 8) break;
      if (names.indexOf(box.type) >= 0) return box;
      pos = box.pos + box.size;
    }
    return null;
  }
  const moov = findChild(0, total, ["moov"]); if (!moov) return null;
  const udta = findChild(moov.dataStart, moov.dataEnd, ["udta"]); if (!udta) return null;
  const meta = findChild(udta.dataStart, udta.dataEnd, ["meta"]); if (!meta) return null;
  // `meta` is a FullBox (4-byte version/flags before children) in most files.
  let ilst = findChild(meta.dataStart + 4, meta.dataEnd, ["ilst"]);
  if (!ilst) ilst = findChild(meta.dataStart, meta.dataEnd, ["ilst"]);
  if (!ilst) return null;
  const C = String.fromCharCode(0xA9);
  const map = {}; map[C + "nam"] = "title"; map[C + "ART"] = "artist"; map[C + "alb"] = "album"; map["aART"] = "albumartist";
  const out = {};
  let pos = ilst.dataStart, guard = 0;
  while (pos + 8 <= ilst.dataEnd && guard++ < 4096) {
    const box = boxAt(pos);
    if (!box || box.size < 8) break;
    const key = map[box.type];
    if (key && !out[key]) {
      const data = findChild(box.dataStart, box.dataEnd, ["data"]);
      if (data) {
        const vstart = data.dataStart + 8; // skip 4-byte type + 4-byte locale
        const len = Math.min(data.dataEnd - vstart, 1000);
        if (len > 0) { h.seekTo(vstart); const vb = h.read(len); if (vb) out[key] = cleanStr(decodeUTF8(vb, 0, vb.length)); }
      }
    }
    pos = box.pos + box.size;
  }
  return out;
}

function readTags(path) {
  let h = null;
  try {
    h = file.handle(path, "read");
    if (!h) return null;
    h.seekTo(0);
    const head = h.read(12);
    if (!head || head.length < 8) return null;
    let res = null;
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) res = parseID3v2(h, head);           // 'ID3'
    else if (head[0] === 0x66 && head[1] === 0x4C && head[2] === 0x61 && head[3] === 0x43) res = parseFlac(h); // 'fLaC'
    else if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) res = parseMp4(h);  // 'ftyp'
    else if (head[0] === 0x4F && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) res = parseOgg(h);  // 'OggS'
    if (!res || (!res.title && !res.artist && !res.album)) {
      const v1 = parseID3v1(h);
      if (v1) res = Object.assign({}, v1, res || {});
    }
    if (res && !res.artist && res.albumartist) res.artist = res.albumartist;
    return res && (res.title || res.artist || res.album) ? res : null;
  } catch (e) {
    console.log("readTags failed for " + path + ": " + e);
    return null;
  } finally {
    try { if (h) h.close(); } catch (_) { }
  }
}

// ---------------------------------------------------------------------------
// Metadata cache
// ---------------------------------------------------------------------------
function loadCache() {
  try { if (file.exists(CACHE_FILE)) metaCache = JSON.parse(file.read(CACHE_FILE)) || {}; }
  catch (e) { metaCache = {}; }
}
let persistTimer = null;
function persistCache() {
  if (persistTimer) return;
  persistTimer = setTimeout(function () {
    persistTimer = null;
    try { file.write(CACHE_FILE, JSON.stringify(metaCache)); } catch (e) { }
  }, 800);
}

// ---------------------------------------------------------------------------
// Background tag scanning (throttled so it never blocks the UI)
// ---------------------------------------------------------------------------
let scanQueue = [];
let scanRunning = false;
function enqueueScan(paths) {
  paths.forEach(function (p) {
    if (!isNetwork(p) && !metaCache[p] && scanQueue.indexOf(p) < 0) scanQueue.push(p);
  });
  if (!scanRunning) runScan();
}
function runScan() {
  if (scanQueue.length === 0) { scanRunning = false; postScanState(); persistCache(); return; }
  scanRunning = true;
  postScanState();
  const path = scanQueue.shift();
  setTimeout(function () {
    const res = readTags(path);
    const entry = metaCache[path] || {};
    if (res) {
      if (res.title) entry.title = res.title;
      if (res.artist) entry.artist = res.artist;
      if (res.album) entry.album = res.album;
    }
    entry.scanned = true;
    metaCache[path] = entry;
    postMeta(path, entry);
    runScan();
  }, 3);
}
function postScanState() {
  if (uiReady) broadcast("pl:scan", { active: scanRunning, remaining: scanQueue.length });
}

// ---------------------------------------------------------------------------
// State <-> UI
// ---------------------------------------------------------------------------
function buildItems() {
  let raw;
  try { raw = playlist.list(); } catch (e) { raw = []; }
  return raw.map(function (it, i) {
    const path = it.filename;
    const c = metaCache[path] || {};
    return {
      i: i,
      path: path,
      title: c.title || it.title || stripExt(baseName(path)),
      artist: c.artist || "",
      album: c.album || "",
      duration: c.duration || 0,
      isCurrent: !!it.isCurrent,
      isPlaying: !!it.isPlaying,
      isNetwork: isNetwork(path)
    };
  });
}
function postMeta(path, entry) {
  if (!uiReady) return;
  broadcast("pl:meta", {
    path: path,
    title: entry.title || "",
    artist: entry.artist || "",
    album: entry.album || "",
    duration: entry.duration || 0
  });
}
let stateTimer = null;
function scheduleState() {
  if (stateTimer) return;
  stateTimer = setTimeout(function () { stateTimer = null; sendState(); }, 100);
}
function sendState() {
  if (!uiReady) return;
  broadcast("pl:state", { items: buildItems(), scanning: scanRunning });
}

function playlistSignature() {
  let l;
  try { l = playlist.list(); } catch (e) { l = []; }
  return l.length + "|" + l.map(function (x) { return (x.isCurrent ? "*" : "") + x.filename; }).join("\n");
}
function onPlaylistChanged() {
  let l;
  try { l = playlist.list(); } catch (e) { l = []; }
  enqueueScan(l.map(function (x) { return x.filename; }));
  sendState();
}

// ---------------------------------------------------------------------------
// Transport controls (play/pause, prev/next, repeat, shuffle) — mirrors the
// mpv properties/commands IINA itself uses.
// ---------------------------------------------------------------------------
function loopMode() {
  try {
    const lf = mpv.getString("loop-file");
    if (lf === "inf" || parseInt(lf, 10)) return "one";
    const lp = mpv.getString("loop-playlist");
    if (lp === "inf" || lp === "force" || parseInt(lp, 10)) return "all";
  } catch (e) { }
  return "off";
}
function setLoop(mode) {
  try {
    if (mode === "all") { mpv.set("loop-playlist", "inf"); mpv.set("loop-file", "no"); }
    else if (mode === "one") { mpv.set("loop-file", "inf"); mpv.set("loop-playlist", "no"); }
    else { mpv.set("loop-playlist", "no"); mpv.set("loop-file", "no"); }
  } catch (e) { }
}
function cycleLoop() {
  const order = ["off", "all", "one"];
  setLoop(order[(order.indexOf(loopMode()) + 1) % order.length]);
}
function togglePlayPause() {
  try {
    if (mpv.getFlag("pause")) core.resume(); else core.pause();
  } catch (e) { }
}
// "Previous" the way music players do it: past ~3s into the track, restart the
// current track; within the first 3s, jump to the previous track.
const PREV_RESTART_THRESHOLD = 3;
function smartPrevious() {
  let pos = 0;
  try { pos = mpv.getNumber("time-pos") || 0; } catch (e) { }
  if (pos >= PREV_RESTART_THRESHOLD) {
    try { core.seekTo(0); } catch (e) { try { mpv.command("seek", ["0", "absolute"]); } catch (_) { } }
  } else {
    try { playlist.playPrevious(); } catch (e) { }
  }
}
function toggleShuffle() {
  try {
    if (shuffleOn) { mpv.command("playlist-unshuffle", []); shuffleOn = false; }
    else { mpv.command("playlist-shuffle", []); shuffleOn = true; }
  } catch (e) { }
  setTimeout(onPlaylistChanged, 60); // the list order changed
}
function getTransport() {
  let paused = false;
  try { paused = mpv.getFlag("pause"); } catch (e) { }
  return { paused: paused, loop: loopMode(), shuffle: shuffleOn };
}
function broadcastTransport(force) {
  if (!uiReady) return;
  const t = getTransport();
  const sig = t.paused + "|" + t.loop + "|" + t.shuffle;
  if (!force && sig === lastTransportSig) return;
  lastTransportSig = sig;
  broadcast("pl:transport", t);
}
function broadcastProgress() {
  if (!uiReady) return;
  let pos = 0, dur = 0, paused = true;
  try { pos = mpv.getNumber("time-pos") || 0; } catch (e) { }
  try { dur = mpv.getNumber("duration") || 0; } catch (e) { }
  try { paused = mpv.getFlag("pause"); } catch (e) { }
  broadcast("pl:progress", { pos: pos, dur: dur, paused: paused });
}

// ---------------------------------------------------------------------------
// Named playlists (stored as M3U8 inside @data)
// ---------------------------------------------------------------------------
function sendSavedList() {
  if (!uiReady) return;
  const names = [];
  try {
    (file.list("@data/", {}) || []).forEach(function (e) {   // trailing slash required by parsePath
      const m = new RegExp("^" + PLAYLIST_PREFIX + "(.+)\\" + PLAYLIST_EXT + "$").exec(e.filename);
      if (m) names.push(m[1]);
    });
  } catch (e) { }
  names.sort();
  broadcast("pl:saved", { names: names });
}
function savePlaylist() {
  const name = utils.prompt("Save current playlist as:");
  if (!name) return;
  const safe = sanitize(name);
  if (!safe) { core.osd("Invalid playlist name"); return; }
  let l;
  try { l = playlist.list(); } catch (e) { l = []; }
  if (!l.length) { core.osd("Playlist is empty"); return; }
  const lines = ["#EXTM3U"];
  l.forEach(function (it) {
    const c = metaCache[it.filename] || {};
    const dur = Math.round(c.duration || 0);
    const disp = (c.artist ? c.artist + " - " : "") + (c.title || stripExt(baseName(it.filename)));
    lines.push("#EXTINF:" + dur + "," + disp);
    lines.push(it.filename);
  });
  try {
    file.write("@data/" + PLAYLIST_PREFIX + safe + PLAYLIST_EXT, lines.join("\n"));
    core.osd("Saved playlist: " + safe);
    sendSavedList();
  } catch (e) { core.osd("Save failed"); console.log("save failed: " + e); }
}
function loadPlaylist(name) {
  const abs = utils.resolvePath("@data/" + PLAYLIST_PREFIX + sanitize(name) + PLAYLIST_EXT);
  if (!abs || !file.exists("@data/" + PLAYLIST_PREFIX + sanitize(name) + PLAYLIST_EXT)) { core.osd("Playlist not found"); return; }
  mpv.command("loadlist", [abs, "replace"]);
  core.osd("Loaded playlist: " + sanitize(name));
  setTimeout(onPlaylistChanged, 350);
}
function importPlaylist() {
  utils.chooseFile("Import a playlist file", { allowedFileTypes: ["m3u", "m3u8", "pls"] })
    .then(function (p) { if (p) { mpv.command("loadlist", [p, "replace"]); setTimeout(onPlaylistChanged, 350); } })
    .catch(function () { });
}
function deleteSaved(name) {
  try { file.delete("@data/" + PLAYLIST_PREFIX + sanitize(name) + PLAYLIST_EXT); sendSavedList(); } catch (e) { }
}

// ---------------------------------------------------------------------------
// Playlist mutations
// ---------------------------------------------------------------------------
function addFiles() {
  utils.chooseFile("Add media to the playlist", { allowedFileTypes: MEDIA_EXT })
    .then(function (p) { if (p) { playlist.add(p, -1); setTimeout(onPlaylistChanged, 120); } })
    .catch(function () { });
}
function clearPlaylist() {
  let n = 0;
  try { n = playlist.count(); } catch (e) { }
  if (n <= 0) return;
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  try { playlist.remove(idx); } catch (e) { }
  setTimeout(onPlaylistChanged, 100);
}

// Physically reorder the mpv playlist so playback order matches `desired`
// (an array of current indices in the target sequence). We place items left to
// right, so the source is always to the right of the target — which is exactly
// the case where mpv's "playlist-move from to" equals a splice(remove, insert).
function reorderPlaylist(desired) {
  const n = desired.length;
  const cur = [];
  for (let i = 0; i < n; i++) cur.push(i);
  for (let t = 0; t < n; t++) {
    const wanted = desired[t];
    const from = cur.indexOf(wanted);
    if (from === t) continue;                 // already in place
    try { playlist.move(from, t); } catch (e) { }
    cur.splice(from, 1);
    cur.splice(t, 0, wanted);
  }
  try { lastSignature = playlistSignature(); } catch (e) { } // don't let the poll re-fire
}

// Sort the actual playlist by a metadata key. This is destructive: it changes
// the real play order (so next/prev/auto-advance follow the sorted order).
function sortPlaylist(key, dir) {
  if (key === "order") return; // no stored "original" order to restore to
  let l;
  try { l = playlist.list(); } catch (e) { return; }
  if (l.length < 2) return;
  const rows = l.map(function (it, i) {
    const c = metaCache[it.filename] || {};
    return {
      i: i,
      title: c.title || it.title || stripExt(baseName(it.filename)),
      artist: c.artist || "",
      album: c.album || "",
      duration: c.duration || 0
    };
  });
  const sign = dir < 0 ? -1 : 1;
  rows.sort(function (a, b) {
    let r;
    if (key === "duration") r = (a.duration || 0) - (b.duration || 0);
    else r = String(a[key] || "").localeCompare(String(b[key] || ""), undefined, { sensitivity: "base", numeric: true });
    if (r === 0) r = a.i - b.i;
    return r * sign;
  });
  reorderPlaylist(rows.map(function (x) { return x.i; }));
  setTimeout(onPlaylistChanged, 50);
}

// ---------------------------------------------------------------------------
// Wire up the UI message handlers (must run AFTER sidebar.loadFile,
// which clears any previously registered listeners).
// ---------------------------------------------------------------------------
// `surface` is either `sidebar` or `standaloneWindow` — both expose the same
// onMessage/postMessage bridge, so the exact same UI drives both.
function registerHandlers(surface, isStandalone) {
  surface.onMessage("ui:ready", function () {
    uiReady = true;
    surface.postMessage("pl:mode", { standalone: !!isStandalone, hideMain: !!preferences.get("hideMain") });
    sendSavedList();
    onPlaylistChanged();
    broadcastTransport(true);
  });
  surface.onMessage("ui:play", function (d) { if (d && typeof d.index === "number") playlist.play(d.index); });
  surface.onMessage("ui:playNext", function () { playlist.playNext(); });
  surface.onMessage("ui:playPrev", function () { playlist.playPrevious(); });
  surface.onMessage("ui:playpause", function () { togglePlayPause(); setTimeout(function () { broadcastTransport(true); }, 40); });
  surface.onMessage("ui:prev-smart", function () { smartPrevious(); });
  surface.onMessage("ui:seek", function (d) {
    if (d && typeof d.pos === "number") {
      try { core.seekTo(d.pos); } catch (e) { }
      setTimeout(function () { broadcastProgress(); }, 60);
    }
  });
  surface.onMessage("ui:cycle-repeat", function () { cycleLoop(); broadcastTransport(true); });
  surface.onMessage("ui:toggle-shuffle", function () { toggleShuffle(); broadcastTransport(true); });
  surface.onMessage("ui:remove", function (d) {
    if (d && d.indexes && d.indexes.length) { try { playlist.remove(d.indexes); } catch (e) { } setTimeout(onPlaylistChanged, 60); }
  });
  surface.onMessage("ui:move", function (d) {
    if (d && typeof d.from === "number" && typeof d.to === "number" && d.from !== d.to) {
      try { playlist.move(d.from, d.to); } catch (e) { } setTimeout(onPlaylistChanged, 60);
    }
  });
  surface.onMessage("ui:add", function () { addFiles(); });
  surface.onMessage("ui:clear", function () { clearPlaylist(); });
  surface.onMessage("ui:reveal", function (d) { if (d && d.path) { try { file.showInFinder(d.path); } catch (e) { } } });
  surface.onMessage("ui:save", function () { savePlaylist(); });
  surface.onMessage("ui:load", function (d) { if (d && d.name) loadPlaylist(d.name); });
  surface.onMessage("ui:import", function () { importPlaylist(); });
  surface.onMessage("ui:delete-saved", function (d) { if (d && d.name) deleteSaved(d.name); });
  surface.onMessage("ui:refresh", function () { onPlaylistChanged(); });
  surface.onMessage("ui:sort", function (d) { if (d && d.key) sortPlaylist(d.key, d.dir < 0 ? -1 : 1); });
  surface.onMessage("ui:popout", function () { openWindow(); });
  surface.onMessage("ui:hidemain", function (d) {
    const on = !!(d && d.hidden);
    preferences.set("hideMain", on);   // remember the user's intent
    preferences.sync();
    applyMainHidden(on);
  });
  // Persist the window size — only the standalone window reports it.
  if (isStandalone) {
    surface.onMessage("ui:winsize", function (d) {
      if (d && d.w > 0 && d.h > 0) {
        preferences.set("winW", Math.round(d.w));
        preferences.set("winH", Math.round(d.h));
        preferences.sync();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Pop-out: the same playlist UI in a freely mouse-resizable standalone window.
// ---------------------------------------------------------------------------
const TITLEBAR_H = 28;
function openWindow() {
  try {
    if (standaloneWindow.isOpen()) { standaloneWindow.open(); return; } // already open → just focus
    standaloneWindow.loadFile("ui/index.html");    // creates the window + loads the UI
    registerHandlers(standaloneWindow, true);      // must come AFTER loadFile (clears listeners)
    standaloneWindow.setProperty({ resizable: true }); // IINA appends " — <plugin name>" to the title itself
    const w = Number(preferences.get("winW")) || 620;
    const h = (Number(preferences.get("winH")) || 520) + TITLEBAR_H;
    standaloneWindow.setFrame(w, h, null, null);   // null x/y → keep current origin
    standaloneWindow.open();
    updateWindowTitle();
    // Optionally hide the main player window, leaving only the playlist.
    if (preferences.get("hideMain")) setTimeout(function () { applyMainHidden(true); }, 300);
  } catch (e) { console.log("openWindow failed: " + e); }
}

// The standalone window title reads "<now playing> — Advanced Playlist" (IINA adds the
// " — <plugin name>" suffix), falling back to "Playlist" when nothing is playing.
function currentItemLabel() {
  try {
    const l = playlist.list();
    const cur = l.filter(function (x) { return x.isCurrent; })[0] ||
                l.filter(function (x) { return x.isPlaying; })[0];
    if (!cur) return null;
    const c = metaCache[cur.filename] || {};
    const title = c.title || cur.title || stripExt(baseName(cur.filename));
    return c.artist ? (c.artist + " – " + title) : title;
  } catch (e) { return null; }
}
function updateWindowTitle() {
  try {
    if (!standaloneWindow.isOpen()) return;
    standaloneWindow.setProperty({ title: currentItemLabel() || "Playlist" });
  } catch (e) { }
}

// The plugin API can't set the standalone window's level ("always on top"), but it can
// minimize the MAIN player window — so we "hide" the player by miniaturizing it and
// keep only the (freely resizable) playlist window on screen.
function applyMainHidden(hidden) {
  try {
    core.window.miniaturized = !!hidden;
    weMinimized = !!hidden;
  } catch (e) { console.log("applyMainHidden: " + e); }
}

// ---------------------------------------------------------------------------
// mpv metadata for the current file — always authoritative.
// ---------------------------------------------------------------------------
function refreshCurrentMetadata() {
  try {
    const md = mpv.getNative("metadata") || {};
    const norm = {};
    for (const k in md) norm[String(k).toLowerCase()] = md[k];
    let list;
    try { list = playlist.list(); } catch (e) { list = []; }
    const cur = list.filter(function (x) { return x.isCurrent; })[0] ||
                list.filter(function (x) { return x.isPlaying; })[0];
    if (!cur) return;
    const path = cur.filename;
    const entry = metaCache[path] || {};
    const title = norm["title"] || norm["media-title"];
    const artist = norm["artist"] || norm["album_artist"] || norm["albumartist"];
    const album = norm["album"];
    if (title) entry.title = cleanStr(String(title));
    if (artist) entry.artist = cleanStr(String(artist));
    if (album) entry.album = cleanStr(String(album));
    const dur = mpv.getNumber("duration");
    if (dur && dur > 0) entry.duration = dur;
    entry.scanned = true;
    metaCache[path] = entry;
    postMeta(path, entry);
    persistCache();
    updateWindowTitle();
  } catch (e) { console.log("refreshCurrentMetadata: " + e); }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
loadCache();

event.on("iina.file-loaded", function () { refreshCurrentMetadata(); scheduleState(); broadcastTransport(true); updateWindowTitle(); });
event.on("iina.file-started", function () { scheduleState(); broadcastTransport(true); });

// Keep the UI in sync with playlist changes made elsewhere (native list, drops, etc.),
// and bring the main window back if the playlist window was closed while it was hidden.
setInterval(function () {
  try {
    const sig = playlistSignature();
    if (sig !== lastSignature) { lastSignature = sig; onPlaylistChanged(); }
    if (weMinimized && !standaloneWindow.isOpen()) { applyMainHidden(false); } // restore, keep the pref
    broadcastTransport(); // reflect pause/loop changes made elsewhere (e.g. spacebar)
  } catch (e) { }
}, 1000);

// Playback position for the progress bar (a CSS transition on the UI side keeps it smooth).
setInterval(function () { try { broadcastProgress(); } catch (e) { } }, 500);

var sidebarInited = false;
function initSidebar() {
  if (sidebarInited) return;
  try {
    sidebar.loadFile("ui/index.html"); // throws if the main window isn't loaded yet
    registerHandlers(sidebar, false);  // must come AFTER loadFile (it clears listeners)
    sidebarInited = true;
  } catch (e) { /* window not ready — retry on iina.window-loaded */ }
}
event.on("iina.window-loaded", initSidebar);
initSidebar(); // in case the window is already loaded when this entry runs

// Menu entries (Plugins menu), plus optional shortcuts.
menu.addItem(menu.item("Show Advanced Playlist", function () {
  try { sidebar.show(); } catch (e) { }
}, { keyBinding: "Meta+Shift+e" }));
menu.addItem(menu.item("Advanced Playlist in Window", function () {
  openWindow();
}, {}));
