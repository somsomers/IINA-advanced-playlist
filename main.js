// Advanced Playlist — backend entry (runs once per player window)
//
// Responsibilities:
//   * Bridge IINA's native playlist (iina.playlist) to a custom HTML UI in the sidebar.
//   * Resolve artist / album / title for every item:
//       1. authoritative metadata from mpv for the currently playing file;
//       2. background tag scanning (ID3v2/ID3v1, MP4, FLAC, Ogg/Opus) for the rest.
//   * Persist a metadata cache and named playlists into the plugin's @data folder.
//   * Search YouTube Music (ytmusic.js) and add the found songs to the playlist.

const { playlist, mpv, event, sidebar, standaloneWindow, menu, core, file, utils, preferences, input, console } = iina;
const ytMusic = require("./ytmusic.js");

// IINA hands a message to the webview as JSON.parse(String.raw`<json>`), so a
// backtick inside any string would end that template literal early (the message is
// lost) and "${" would be evaluated as code. Titles from YouTube or file tags can
// contain either, so neutralise them before posting.
function bridgeSafe(value) {
  if (typeof value === "string") return value.replace(/`/g, "'").replace(/\$\{/g, "$ {");
  if (Array.isArray(value)) return value.map(bridgeSafe);
  if (value && typeof value === "object") {
    const out = {};
    for (const key in value) out[key] = bridgeSafe(value[key]);
    return out;
  }
  return value;
}

function postTo(surface, name, data) {
  surface.postMessage(name, bridgeSafe(data));
}

// Post a message to BOTH surfaces (sidebar tab + standalone window). Posting to a
// surface whose webview isn't loaded is a harmless no-op.
function broadcast(name, data) {
  try { postTo(sidebar, name, data); } catch (e) { }
  try { postTo(standaloneWindow, name, data); } catch (e) { }
}

const CACHE_FILE = "@data/metadata-cache.json";
const PLAYLIST_PREFIX = "playlist_";
const PLAYLIST_EXT = ".m3u8";
const AUTOSAVE_DELAY = 1200;   // ms of quiet after a change before the playlist is rewritten

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
let activePlaylistName = null; // saved playlist that auto-save writes back to (this window only)
let lastSavedContent = "";     // what that file holds, so an unchanged playlist isn't rewritten

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
// Playlist names become file names, so only strip what a file name can't hold —
// \w would also mangle non-Latin names (e.g. Cyrillic) into underscores.
function sanitize(name) {
  return String(name).replace(/[\/\\:*?"<>|\x00-\x1f]+/g, "_").replace(/^[.\s]+/, "").trim().slice(0, 120);
}

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
// Windows-1251 (Cyrillic) high range 0x80..0xBF; 0xC0..0xFF map linearly to U+0410..U+044F.
const CP1251_HI = [
  0x0402, 0x0403, 0x201A, 0x0453, 0x201E, 0x2026, 0x2020, 0x2021, 0x20AC, 0x2030, 0x0409, 0x2039, 0x040A, 0x040C, 0x040B, 0x040F,
  0x0452, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x0098, 0x2122, 0x0459, 0x203A, 0x045A, 0x045C, 0x045B, 0x045F,
  0x00A0, 0x040E, 0x045E, 0x0408, 0x00A4, 0x0490, 0x00A6, 0x00A7, 0x0401, 0x00A9, 0x0404, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x0407,
  0x00B0, 0x00B1, 0x0406, 0x0456, 0x0491, 0x00B5, 0x00B6, 0x00B7, 0x0451, 0x2116, 0x0454, 0x00BB, 0x0458, 0x0405, 0x0455, 0x0457
];
function decodeCP1251(b, s, e) {
  let r = "";
  e = Math.min(e, b.length);
  for (let i = s; i < e; i++) {
    const c = b[i];
    if (c === 0) break;
    if (c < 0x80) r += String.fromCharCode(c);
    else if (c < 0xC0) r += String.fromCharCode(CP1251_HI[c - 0x80]);
    else r += String.fromCharCode(0x0410 + (c - 0xC0));
  }
  return r;
}
// Legacy ID3 text (ID3v1 and ID3v2 "ISO-8859-1" frames) is very often actually
// Windows-1251 in Russian files. If the high bytes look Cyrillic, decode as CP1251.
function decodeLegacy(b, s, e) {
  e = Math.min(e, b.length);
  let high = 0, cyr = 0;
  for (let i = s; i < e; i++) {
    const c = b[i];
    if (c === 0) break;
    if (c >= 0x80) { high++; if (c >= 0xC0 || c === 0xA8 || c === 0xB8) cyr++; }
  }
  // Require a couple of Cyrillic-range bytes so a lone accented Latin-1 char
  // (e.g. "Café") isn't mistaken for Cyrillic.
  return (high >= 2 && cyr / high >= 0.6) ? decodeCP1251(b, s, e) : decodeLatin1(b, s, e);
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
  return cleanStr(decodeLegacy(b, p, e)); // enc 0 = "ISO-8859-1", but often Windows-1251
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
    title: cleanStr(decodeLegacy(b, 3, 33)),
    artist: cleanStr(decodeLegacy(b, 33, 63)),
    album: cleanStr(decodeLegacy(b, 63, 93))
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
const CACHE_VERSION = 2; // bump to invalidate stale caches (e.g. the pre-CP1251 mojibake)
function loadCache() {
  try {
    if (file.exists(CACHE_FILE)) {
      const obj = JSON.parse(file.read(CACHE_FILE)) || {};
      metaCache = obj.__v === CACHE_VERSION ? obj : { __v: CACHE_VERSION }; // drop old cache
      return;
    }
  } catch (e) { }
  metaCache = { __v: CACHE_VERSION };
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
// yt-dlp integration: enrich network (YouTube etc.) items with artist/album/track,
// and expand a pasted URL (single video OR a whole playlist) into tracks.
// mpv only forwards the title of a YouTube stream, so we ask yt-dlp directly.
// All calls are async (iina.utils.exec) so nothing blocks.
// ---------------------------------------------------------------------------
let ytdlpPath = null;   // cached only once found (so a path set later in prefs is picked up)
let ytQueue = [];
let ytRunning = false;
const ytAttempted = {}; // url -> true (don't retry endlessly)

function findYtdlp() {
  if (ytdlpPath) return ytdlpPath;
  const cands = [];
  try { const p = preferences.get("ytdlpPath"); if (p) cands.push(String(p)); } catch (e) { }
  cands.push("/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp",
             "/opt/homebrew/bin/youtube-dl", "/usr/local/bin/youtube-dl");
  for (let i = 0; i < cands.length; i++) {
    try { if (cands[i] && file.exists(cands[i])) { ytdlpPath = cands[i]; break; } } catch (e) { }
  }
  if (!ytdlpPath) ytdlpPath = findBundledYtdlp();
  return ytdlpPath;
}
// IINA ships yt-dlp inside its app bundle (named "youtube-dl"). A bare name
// makes utils.exec run that bundled binary, so no Homebrew install is needed.
function findBundledYtdlp() {
  const names = ["yt-dlp", "youtube-dl"];
  for (let i = 0; i < names.length; i++) {
    try { if (utils.fileInPath(names[i])) return names[i]; } catch (e) { }
  }
  return null;
}

function enqueueEnrich(urls, front) {
  if (!findYtdlp()) return;
  urls.forEach(function (u) {
    if (!isNetwork(u) || ytAttempted[u]) return;
    const c = metaCache[u] || {};
    if (c.artist && c.album) return;           // already rich
    if (ytQueue.indexOf(u) >= 0) return;
    if (front) ytQueue.unshift(u); else ytQueue.push(u);
  });
  if (!ytRunning) runEnrich();
}
function runEnrich() {
  if (ytQueue.length === 0) { ytRunning = false; return; }
  ytRunning = true;
  const url = ytQueue.shift();
  ytAttempted[url] = true;
  utils.exec(ytdlpPath, ["--no-playlist", "--print", "%(artist,creator,uploader|)s",
                         "--print", "%(album|)s", "--print", "%(track,title|)s", url])
    .then(function (res) {
      if (res && res.status === 0 && res.stdout) {
        const p = res.stdout.split("\n");
        let artist = cleanStr((p[0] || "").trim()).replace(/\s*-\s*Topic$/i, "");
        let album = cleanStr((p[1] || "").trim());
        let title = cleanStr((p[2] || "").trim());
        if (artist === "NA") artist = "";
        if (album === "NA") album = "";
        if (title === "NA") title = "";
        const entry = metaCache[url] || {};
        if (artist) entry.artist = artist;
        if (album) entry.album = album;
        if (title && !entry.title) entry.title = title;
        entry.scanned = true;
        metaCache[url] = entry;
        postMeta(url, entry);
        persistCache();
        updateWindowTitle();
      }
    })
    .catch(function () { })
    .then(function () { runEnrich(); });
}

// Add a URL. yt-dlp flat extraction handles both a single video and a full
// playlist (one entry vs many); non-yt-dlp URLs are added as-is.
function addUrl(url) {
  url = String(url || "").trim();
  if (!url) return;
  if (!findYtdlp() || !/^https?:\/\//i.test(url)) {
    addToPlaylist(url, -1); setTimeout(onPlaylistChanged, 150); return;
  }
  core.osd("Fetching…");
  utils.exec(ytdlpPath, ["--flat-playlist", "--print",
                         "%(webpage_url,url)s\t%(title|)s\t%(uploader,channel|)s", url])
    .then(function (res) {
      const urls = [];
      if (res && res.status === 0 && res.stdout && res.stdout.trim()) {
        res.stdout.split("\n").forEach(function (ln) {
          if (!ln.trim()) return;
          const c = ln.split("\t");
          const vurl = (c[0] || "").trim();
          if (!vurl) return;
          urls.push(vurl);
          const entry = metaCache[vurl] || {};
          const title = cleanStr((c[1] || "").trim());
          const artist = cleanStr((c[2] || "").trim()).replace(/\s*-\s*Topic$/i, "");
          if (title && title !== "NA" && !entry.title) entry.title = title;
          if (artist && artist !== "NA" && !entry.artist) entry.artist = artist;
          metaCache[vurl] = entry; // no scanned flag → full enrichment still runs
        });
      }
      if (urls.length) {
        addToPlaylist(urls, -1);
        persistCache();
        core.osd("Added " + urls.length + (urls.length === 1 ? " track" : " tracks"));
        enqueueEnrich(urls);
        setTimeout(onPlaylistChanged, 200);
      } else {
        addToPlaylist(url, -1); setTimeout(onPlaylistChanged, 150);
      }
    })
    .catch(function () { addToPlaylist(url, -1); setTimeout(onPlaylistChanged, 150); });
}

// ---------------------------------------------------------------------------
// State <-> UI
// ---------------------------------------------------------------------------
// Read the playlist straight from mpv (the source of truth). IINA's own
// playlist model (what iina.playlist.list() returns) is NOT refreshed after a
// reorder — a move doesn't change playlist-count, so IINA never re-reads it —
// which left the displayed order stale while playback used the real mpv order.
function getRawPlaylist() {
  let pl;
  try { pl = mpv.getNative("playlist"); } catch (e) { pl = null; }
  if (!pl || !pl.length) return [];
  return pl.map(function (it) {
    return {
      filename: it.filename || "",
      title: (it.title != null && it.title !== "") ? String(it.title) : null,
      isCurrent: it.current === true,
      isPlaying: it.playing === true
    };
  });
}

function buildItems() {
  let raw;
  try { raw = getRawPlaylist(); } catch (e) { raw = []; }
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
  try { l = getRawPlaylist(); } catch (e) { l = []; }
  return l.length + "|" + l.map(function (x) { return (x.isCurrent ? "*" : "") + x.filename; }).join("\n");
}
function onPlaylistChanged() {
  let l;
  try { l = getRawPlaylist(); } catch (e) { l = []; }
  enqueueScan(l.map(function (x) { return x.filename; }));
  scheduleAutoSave();
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
  releasePauseHold(); // an explicit play/pause wins over "start paused"
  try {
    if (mpv.getFlag("pause")) core.resume(); else core.pause();
  } catch (e) { }
}
function seekToStart() {
  try { core.seekTo(0); } catch (e) { try { mpv.command("seek", ["0", "absolute"]); } catch (_) { } }
}
// Winamp-style "Play": always (re)starts the current track from the beginning.
function restartPlayback() {
  releasePauseHold();
  seekToStart();
  try { core.resume(); } catch (e) { }
}
// Winamp-style "Stop": pause and rewind. mpv's own "stop" would clear the playlist.
function stopPlayback() {
  releasePauseHold();
  try { core.pause(); } catch (e) { }
  seekToStart();
}
// "Previous" the way music players do it: past ~3s into the track, restart the
// current track; within the first 3s, jump to the previous track.
const PREV_RESTART_THRESHOLD = 3;
function smartPrevious() {
  let pos = 0;
  try { pos = mpv.getNumber("time-pos") || 0; } catch (e) { }
  if (pos >= PREV_RESTART_THRESHOLD) {
    seekToStart();
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
  let paused = false, volume = 100, muted = false;
  try { paused = mpv.getFlag("pause"); } catch (e) { }
  try { const v = core.audio.volume; if (typeof v === "number") volume = Math.round(v); } catch (e) { }
  try { muted = !!core.audio.muted; } catch (e) { }
  return { paused: paused, loop: loopMode(), shuffle: shuffleOn, volume: volume, muted: muted };
}
function setVolume(v) {
  try {
    v = Math.max(0, Math.min(100, Math.round(v)));
    core.audio.volume = v;
    if (v > 0 && core.audio.muted) core.audio.muted = false; // nudging volume unmutes
  } catch (e) { }
}
function toggleMute() {
  try { core.audio.muted = !core.audio.muted; } catch (e) { }
}
function broadcastTransport(force) {
  if (!uiReady) return;
  const t = getTransport();
  const sig = t.paused + "|" + t.loop + "|" + t.shuffle + "|" + t.volume + "|" + t.muted;
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
// Start paused — a freshly opened playlist selects its first track without
// playing it ("pausePlaylistOnOpen" and "pauseHoldSeconds" preferences).
//   * mpv's loadlist starts the first entry right away, and IINA resumes playback
//     by itself once a track is loaded (unless IINA's own "Pause when media is
//     opened" setting is on) — a plugin can't switch that off.
//   * So the plugin pauses before the load and arms a one-shot "hold" that undoes
//     IINA's automatic resume of the new playlist's first track.
//   * The hold ends after that undo, when another track starts (the user moved
//     on), when play/pause is toggled from the plugin, or on a timeout if IINA
//     never resumes (or the load failed).
// ---------------------------------------------------------------------------
const PLAYLIST_FILE_EXTS = ["m3u", "m3u8", "pls"];
const PAUSE_HOLD_START_TIMEOUT = 2000; // ms for the first track to start after the load
// Allowed range and fallback for the "pauseHoldSeconds" preference.
const PAUSE_HOLD_MIN_SECONDS = 0.5;
const PAUSE_HOLD_MAX_SECONDS = 10;
const PAUSE_HOLD_DEFAULT_SECONDS = 1;

let pauseHoldArmed = false;
let pauseHoldTrackStarted = false; // the first track of the new playlist has started
let pauseHoldTimer = null;

function pauseOnOpenEnabled() {
  try { return !!preferences.get("pausePlaylistOnOpen"); } catch (e) { return false; }
}
// How long to keep holding once the track is loaded, in ms: for video and tracks with
// cover art IINA resumes on the first video reconfig, which comes a moment later.
function pauseHoldGraceMs() {
  let seconds = NaN;
  try { seconds = Number(preferences.get("pauseHoldSeconds")); } catch (e) { }
  if (!(seconds > 0)) seconds = PAUSE_HOLD_DEFAULT_SECONDS;
  return Math.min(Math.max(seconds, PAUSE_HOLD_MIN_SECONDS), PAUSE_HOLD_MAX_SECONDS) * 1000;
}
// Replace the hold's pending timeout; 0 = no timeout.
function setPauseHoldTimeout(ms) {
  if (pauseHoldTimer) clearTimeout(pauseHoldTimer);
  pauseHoldTimer = ms > 0 ? setTimeout(releasePauseHold, ms) : null;
}
function armPauseHold() {
  if (!pauseOnOpenEnabled()) return;
  pauseHoldArmed = true;
  pauseHoldTrackStarted = false;
  setPauseHoldTimeout(PAUSE_HOLD_START_TIMEOUT);
  try { mpv.set("pause", true); } catch (e) { }
}
function releasePauseHold() {
  pauseHoldArmed = false;
  pauseHoldTrackStarted = false;
  setPauseHoldTimeout(0);
}
// Undo IINA's automatic resume. IINA resumes at most once per loaded track, so the
// hold ends here. Reads the live flag: the value IINA passes with mpv.pause.changed
// may be stale, as it is read asynchronously.
function enforcePauseHold() {
  if (!pauseHoldArmed) return;
  let paused = true;
  try { paused = mpv.getFlag("pause"); } catch (e) { }
  if (paused) return;
  try { mpv.set("pause", true); } catch (e) { }
  releasePauseHold();
  broadcastTransport(true);
}
// A local .m3u/.m3u8/.pls. Remote .m3u8 URLs are HLS streams, not playlists.
function isLocalPlaylistFile(url) {
  const s = String(url || "");
  if (s.indexOf("file://") !== 0) return false;
  const ext = s.slice(s.lastIndexOf(".") + 1).toLowerCase();
  return PLAYLIST_FILE_EXTS.indexOf(ext) >= 0;
}
// iina.file-started. When IINA opens a playlist file itself (Finder, File ▸ Open,
// launching IINA with it), mpv first "starts" the playlist file, then its tracks.
function onFileStartedForPauseHold() {
  let url = null;
  try { url = core.status.url; } catch (e) { }
  if (isLocalPlaylistFile(url)) { armPauseHold(); return; }
  if (!pauseHoldArmed) return;
  if (pauseHoldTrackStarted) { releasePauseHold(); return; } // another track — the user moved on
  pauseHoldTrackStarted = true;
  setPauseHoldTimeout(0); // loading (e.g. a YouTube track) may take a while
}
// iina.file-loaded. For audio-only tracks IINA has already resumed by now.
function onFileLoadedForPauseHold() {
  if (!pauseHoldArmed) return;
  enforcePauseHold();
  if (pauseHoldArmed) setPauseHoldTimeout(pauseHoldGraceMs());
}

// ---------------------------------------------------------------------------
// Configurable playback hotkeys.
//   * Main player window: registered via iina.input (mpv key strings).
//   * Plugin window / sidebar: matched in the webview and sent back as commands.
// Bindings live in the plugin preferences (hk_<action>) and are edited on the
// plugin's preferences page. System-wide (app-in-background) is not possible
// from a plugin, so these only fire while an IINA window is focused.
// ---------------------------------------------------------------------------
function afterTransportChange() { setTimeout(function () { broadcastTransport(true); }, 40); }
const HK_ACTIONS = {
  prev: function () { try { playlist.playPrevious(); } catch (e) { } },
  play: function () { restartPlayback(); afterTransportChange(); },
  pause: function () { togglePlayPause(); afterTransportChange(); },
  stop: function () { stopPlayback(); afterTransportChange(); },
  next: function () { try { playlist.playNext(); } catch (e) { } },
  seekBack: function () { try { core.seek(-10, false); } catch (e) { } },
  seekFwd: function () { try { core.seek(10, false); } catch (e) { } }
};
const HK_ACTION_KEYS = ["prev", "play", "pause", "stop", "next", "seekBack", "seekFwd"];
let appliedHotkeys = [];   // mpv keys currently registered with iina.input
let lastHotkeySig = "";

function readHotkeys() {
  const cfg = {};
  HK_ACTION_KEYS.forEach(function (a) {
    let v = "";
    try { v = preferences.get("hk_" + a) || ""; } catch (e) { }
    cfg[a] = String(v || "");
  });
  return cfg;
}
function applyHotkeys(cfg) {
  appliedHotkeys.forEach(function (k) { try { input.onKeyDown(k, null, input.PRIORITY_HIGH); } catch (e) { } });
  appliedHotkeys = [];
  HK_ACTION_KEYS.forEach(function (a) {
    const key = cfg[a];
    if (!key) return;
    try {
      input.onKeyDown(key, function () { HK_ACTIONS[a](); return true; }, input.PRIORITY_HIGH);
      appliedHotkeys.push(key);
    } catch (e) { console.log("hotkey register failed (" + a + " = " + key + "): " + e); }
  });
}
function refreshHotkeys(force) {
  const cfg = readHotkeys();
  const sig = HK_ACTION_KEYS.map(function (a) { return cfg[a]; }).join("|");
  if (!force && sig === lastHotkeySig) return;
  lastHotkeySig = sig;
  applyHotkeys(cfg);
  try { preferences.sync(); } catch (e) { }
  broadcast("pl:hotkeys", cfg);
}
function broadcastHotkeys() { if (uiReady) broadcast("pl:hotkeys", readHotkeys()); }

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
function playlistFilePath(safeName) { return "@data/" + PLAYLIST_PREFIX + safeName + PLAYLIST_EXT; }
function readTextFile(path) { try { return file.read(path) || ""; } catch (e) { return ""; } }

// M3U8 text for the playlist as it stands right now ("" when it is empty).
function buildCurrentPlaylistContent() {
  let l;
  try { l = getRawPlaylist(); } catch (e) { return ""; }
  if (!l.length) return "";
  const lines = ["#EXTM3U"];
  l.forEach(function (it) {
    const c = metaCache[it.filename] || {};
    const title = c.title || it.title || stripExt(baseName(it.filename)); // it.title captures e.g. a YouTube title
    const artist = c.artist || "";
    const album = c.album || "";
    const dur = Math.round(c.duration || 0);
    lines.push("#EXTINF:" + dur + "," + (artist ? artist + " - " : "") + title);
    // Rich metadata so titles/artist/album survive a round-trip (mpv ignores unknown # comments).
    lines.push("#PLAYLISTPRO:" + JSON.stringify({ t: title, a: artist, al: album, d: dur }));
    lines.push(it.filename);
  });
  return lines.join("\n");
}

// Save under `name`, overwriting a playlist of the same name. The UI pre-fills the
// active playlist's name, so keeping it updates that playlist and changing it
// creates a new one ("Save As") — which then becomes the active playlist.
function savePlaylist(name) {
  const safe = sanitize(name || "");
  if (!safe) { core.osd("Invalid playlist name"); return; }
  const content = buildCurrentPlaylistContent();
  if (!content) { core.osd("Playlist is empty"); return; }
  try {
    file.write(playlistFilePath(safe), content);
    setActivePlaylist(safe, content);
    core.osd("Saved playlist: " + safe);
    sendSavedList();
  } catch (e) { core.osd("Save failed"); console.log("save failed: " + e); }
}
// Repopulate metaCache from the #PLAYLISTPRO lines we wrote, so titles/artist/album show
// immediately after loading — mpv's loadlist does not restore #EXTINF titles.
function restoreMetaFromM3U(path) {
  try {
    const content = readTextFile(path);
    if (!content) return;
    const lines = content.split(/\r?\n/);
    let pending = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf("#PLAYLISTPRO:") === 0) {
        try { pending = JSON.parse(line.slice(13)); } catch (e) { pending = null; }
      } else if (line && line.charAt(0) !== "#") {
        const url = line.trim();
        if (url && pending && (pending.t || pending.a || pending.al)) {
          metaCache[url] = { title: pending.t || "", artist: pending.a || "", album: pending.al || "", duration: pending.d || 0, scanned: true };
        }
        pending = null;
      }
    }
    persistCache();
  } catch (e) { console.log("restoreMetaFromM3U: " + e); }
}
function loadPlaylist(name) {
  const safe = sanitize(name);
  const rel = playlistFilePath(safe);
  const abs = utils.resolvePath(rel);
  if (!abs || !file.exists(rel)) { core.osd("Playlist not found"); return; }
  restoreMetaFromM3U(rel);
  armPauseHold();
  mpv.command("loadlist", [abs, "replace"]);
  setActivePlaylist(safe, readTextFile(rel)); // further edits auto-save back into this playlist
  core.osd("Loaded playlist: " + safe);
  setTimeout(onPlaylistChanged, 350);
}
function importPlaylist() {
  utils.chooseFile("Import a playlist file", { allowedFileTypes: ["m3u", "m3u8", "pls"] })
    .then(function (p) {
      if (!p) return;
      restoreMetaFromM3U(p);
      armPauseHold();
      mpv.command("loadlist", [p, "replace"]);
      setActivePlaylist(null, ""); // an external file is not one of our saved playlists
      setTimeout(onPlaylistChanged, 350);
    })
    .catch(function () { });
}
function deleteSaved(name) {
  const safe = sanitize(name);
  try { file.delete(playlistFilePath(safe)); sendSavedList(); } catch (e) { }
  if (safe === activePlaylistName) setActivePlaylist(null, "");
  if (safe === lastPlaylistName()) rememberLastPlaylist("");
}

// ---------------------------------------------------------------------------
// Reopen the last playlist at launch ("restoreLastPlaylist" preference).
// The name of the playlist last saved or loaded in ANY window is kept in the
// "lastPlaylistName" preference. This entry runs once per player; at launch
// the first player stays idle unless IINA was started to open a file, so an
// idle player a moment after the entry ran means "IINA was simply launched".
// ---------------------------------------------------------------------------
const RESTORE_CHECK_DELAY = 1000; // ms for a file passed at launch to start opening

function lastPlaylistName() {
  try { return String(preferences.get("lastPlaylistName") || ""); } catch (e) { return ""; }
}
function rememberLastPlaylist(safeName) {
  if (safeName === lastPlaylistName()) return;
  try { preferences.set("lastPlaylistName", safeName); preferences.sync(); } catch (e) { }
}
function restoreLastPlaylistEnabled() {
  try { return !!preferences.get("restoreLastPlaylist"); } catch (e) { return false; }
}
function playerIsIdle() {
  try { return !!core.status.idle; } catch (e) { return false; }
}
// Opened through IINA (core.open), not mpv's loadlist: IINA ignores tracks that
// mpv starts in an idle player, and only its own open path shows the window.
// Opening a local .m3u8 this way also arms the start-paused hold by itself.
function restoreLastPlaylist() {
  if (!restoreLastPlaylistEnabled() || !playerIsIdle()) return;
  const safe = lastPlaylistName();
  if (!safe) return;
  const rel = playlistFilePath(safe);
  const abs = utils.resolvePath(rel);
  if (!abs || !file.exists(rel)) return;
  restoreMetaFromM3U(rel);
  core.open(abs);
  setActivePlaylist(safe, readTextFile(rel));
  setTimeout(onPlaylistChanged, 350);
}

// ---------------------------------------------------------------------------
// Auto-save — mirror every playlist change back into the active saved playlist.
// Switched on with the "autoSave" preference. The target is whatever playlist
// was last saved or loaded in THIS window, so another window playing unrelated
// files can never overwrite it.
// ---------------------------------------------------------------------------
let autoSaveTimer = null;
let lastAutoSaveSig = "";

function autoSaveEnabled() {
  try { return !!preferences.get("autoSave"); } catch (e) { return false; }
}
// Point auto-save at a saved playlist (null = none). `content` is what that file
// currently holds.
function setActivePlaylist(safeName, content) {
  activePlaylistName = safeName || null;
  lastSavedContent = content || "";
  if (activePlaylistName) rememberLastPlaylist(activePlaylistName);
  broadcastActivePlaylist();
}
function scheduleAutoSave() {
  if (!activePlaylistName || !autoSaveEnabled()) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(runAutoSave, AUTOSAVE_DELAY);
}
// A playlist that has no track in common with the saved one is a different
// playlist — opening an unrelated file replaces mpv's whole list, and that must
// not be written over the user's saved playlist.
function sharesTracksWithSaved(items) {
  if (!lastSavedContent) return true; // nothing to compare against
  const saved = {};
  lastSavedContent.split(/\r?\n/).forEach(function (ln) {
    const s = ln.trim();
    if (s && s.charAt(0) !== "#") saved[s] = true;
  });
  for (let i = 0; i < items.length; i++) if (saved[items[i].filename]) return true;
  return false;
}
function runAutoSave() {
  autoSaveTimer = null;
  if (!activePlaylistName || !autoSaveEnabled()) return;
  let items;
  try { items = getRawPlaylist(); } catch (e) { return; }
  if (!items.length) return;                                    // never wipe the saved playlist
  if (!sharesTracksWithSaved(items)) { setActivePlaylist(null, ""); return; } // unrelated list
  const content = buildCurrentPlaylistContent();
  if (!content || content === lastSavedContent) return;         // unchanged — leave the file alone
  try {
    file.write(playlistFilePath(activePlaylistName), content);
    lastSavedContent = content;
  } catch (e) { console.log("auto-save failed: " + e); }
}
// The UI needs the active playlist's name for the Save dialog, and the auto-save
// flag for the footer indicator.
function broadcastActivePlaylist() {
  if (!uiReady) return;
  broadcast("pl:active", { name: activePlaylistName || "", autoSave: autoSaveEnabled() });
}
// Pick up a toggle made on the preferences page (polled, like the hotkeys).
function refreshAutoSaveState() {
  const sig = (autoSaveEnabled() ? "1" : "0") + "|" + (activePlaylistName || "");
  if (sig === lastAutoSaveSig) return;
  lastAutoSaveSig = sig;
  try { preferences.sync(); } catch (e) { }
  broadcastActivePlaylist();
  scheduleAutoSave(); // switching it on stores the changes made while it was off
}

// ---------------------------------------------------------------------------
// Playlist mutations
// ---------------------------------------------------------------------------
// Tracks waiting for the player to leave the idle state (see addToPlaylist).
let pendingAdds = [];

// IINA's playlist.add is a no-op while the player is idle (nothing opened yet,
// e.g. a fresh install with no playlist to restore at launch). In that case the
// first track is opened through IINA itself and the rest are appended once it
// has loaded. Returns false if nothing could be added.
function addToPlaylist(paths, at) {
  const list = [].concat(paths).filter(Boolean);
  if (!list.length) return false;
  if (!playerIsIdle()) return playlist.add(list, at) !== false;
  pendingAdds = pendingAdds.concat(list.slice(1));
  core.open(list[0]);
  return true;
}
function flushPendingAdds() {
  if (!pendingAdds.length) return;
  const list = pendingAdds;
  pendingAdds = [];
  playlist.add(list, -1);
  setTimeout(onPlaylistChanged, 150);
}

function addFiles() {
  // The plugin API's file picker is single-selection only (no multi-select),
  // so use "Add folder" to add many files at once.
  utils.chooseFile("Add a media file", { allowedFileTypes: MEDIA_EXT })
    .then(function (p) { if (p) { addToPlaylist(p, -1); setTimeout(onPlaylistChanged, 120); } })
    .catch(function () { });
}
function addFolder() {
  utils.chooseFile("Add a folder", { chooseDir: true })
    .then(function (folder) {
      if (!folder) return;
      let entries;
      try { entries = file.list(folder, { includeSubDir: true }) || []; } catch (e) { entries = []; }
      const paths = [];
      entries.forEach(function (e) {
        if (e.isDir) return;
        const ext = (e.filename.split(".").pop() || "").toLowerCase();
        if (MEDIA_EXT.indexOf(ext) < 0) return;
        paths.push(folder + e.path); // e.path is relative to the chosen folder (starts with "/")
      });
      paths.sort();
      if (!paths.length) { core.osd("No media files found in the folder"); return; }
      addToPlaylist(paths, -1);
      core.osd("Added " + paths.length + (paths.length === 1 ? " file" : " files"));
      setTimeout(onPlaylistChanged, 150);
    })
    .catch(function () { });
}
function clearPlaylist() {
  let l;
  try { l = getRawPlaylist(); } catch (e) { l = []; }
  if (l.length <= 1) return; // nothing to clear beyond the current track
  // Keep the currently playing track (removing it stops playback and closes the
  // player). Use IINA's own playlist.remove — NOT the raw mpv "playlist-clear"
  // command, which changes mpv but leaves IINA's playlist model out of sync
  // (the list only collapses later, when switching tracks re-syncs it).
  let keep = -1;
  for (let i = 0; i < l.length; i++) { if (l[i].isCurrent || l[i].isPlaying) { keep = i; break; } }
  if (keep < 0) keep = 0; // keep something so the player stays alive
  const idx = [];
  for (let i = 0; i < l.length; i++) if (i !== keep) idx.push(i);
  try { playlist.remove(idx); } catch (e) { }
  setTimeout(onPlaylistChanged, 80);
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

// Drag reorder: move item `from` to the insert-before gap `gap` (0..n). Builds the
// resulting permutation and applies it through the (verified) reorderPlaylist.
function moveItem(from, gap) {
  const n = getRawPlaylist().length;
  if (from < 0 || from >= n || gap < 0 || gap > n) return;
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.splice(from, 1);
  order.splice(gap > from ? gap - 1 : gap, 0, from);
  let changed = false;
  for (let i = 0; i < n; i++) if (order[i] !== i) { changed = true; break; }
  if (!changed) return;
  reorderPlaylist(order);
  setTimeout(onPlaylistChanged, 60);
}

// Index of the currently playing/current track in the raw playlist, or -1.
function currentIndex() {
  let l;
  try { l = getRawPlaylist(); } catch (e) { l = []; }
  for (let i = 0; i < l.length; i++) if (l[i].isCurrent || l[i].isPlaying) return i;
  return -1;
}

// "Play next": move an existing item so it sits right after the current track
// (or to the top when nothing is playing). Playback of the current track is
// unaffected; only the queue order changes.
function queueNext(index) {
  const n = getRawPlaylist().length;
  if (index < 0 || index >= n) return;
  const cur = currentIndex();
  if (index === cur) return;                 // it's the current track — nothing to queue
  moveItem(index, cur >= 0 ? cur + 1 : 0);   // gap = insert-before slot after the current track
  core.osd("Playing next");
}

// Insert index for "play next": right after the current track, or the top when
// nothing is playing. Appends (‑1) when the current track is last, since the
// plugin API rejects an insert index equal to the playlist length.
function indexAfterCurrent() {
  let n;
  try { n = getRawPlaylist().length; } catch (e) { n = 0; }
  const next = currentIndex() + 1;     // 0 when nothing is playing
  return next < n ? next : -1;
}

// "Copy next": insert a duplicate of the item right after the current track,
// leaving the original in place.
function copyNext(index) {
  let l;
  try { l = getRawPlaylist(); } catch (e) { l = []; }
  if (index < 0 || index >= l.length) return;
  const path = l[index].filename;
  if (!path) return;
  try { playlist.add(path, indexAfterCurrent()); } catch (e) { }
  core.osd("Copied next");
  setTimeout(onPlaylistChanged, 150);
}

// ---------------------------------------------------------------------------
// YouTube Music: search (see ytmusic.js) and add the chosen songs.
// ---------------------------------------------------------------------------
// Reply only to the surface that asked. `requestId` comes back unchanged so the
// UI can drop answers to queries the user has already replaced.
function ytmSortByPlaysEnabled() {
  try { return !!preferences.get("ytmSortByPlays"); } catch (e) { return false; }
}

// The preference is read per search, so a toggle takes effect on the next query.
function searchYtMusic(surface, query, requestId) {
  ytMusic.searchSongs(query, findYtdlp())
    .then(function (result) {
      const sortedByPlays = ytmSortByPlaysEnabled() && !result.titlesOnly; // no counts in the fallback
      const tracks = sortedByPlays ? ytMusic.sortByPlaysDescending(result.tracks) : result.tracks;
      postTo(surface, "pl:ytm-results", {
        requestId: requestId, tracks: tracks, titlesOnly: result.titlesOnly, sortedByPlays: sortedByPlays
      });
    })
    .catch(function (e) {
      console.log("YouTube Music search failed: " + e);
      postTo(surface, "pl:ytm-results",
        { requestId: requestId, tracks: [], error: "Search failed — check the internet connection." });
    });
}

// Cache what the search already knows, so the new rows show artist/album/duration
// immediately instead of waiting for a yt-dlp lookup per track.
function rememberTrackMetadata(track) {
  const entry = metaCache[track.url] || {};
  if (track.title) entry.title = track.title;
  if (track.artist) entry.artist = track.artist;
  if (track.album) entry.album = track.album;
  if (track.duration) entry.duration = track.duration;
  metaCache[track.url] = entry;
}

function countLabel(n) { return n + (n === 1 ? " track" : " tracks"); }

// Append the tracks, or insert them right after the current one (`playNext`).
function addYtMusicTracks(tracks, playNext) {
  const valid = tracks.filter(function (t) { return t && typeof t.url === "string" && t.url; });
  if (!valid.length) return;
  valid.forEach(rememberTrackMetadata);
  persistCache();
  const urls = valid.map(function (t) { return t.url; });
  let added = false;
  try { added = addToPlaylist(urls, playNext ? indexAfterCurrent() : -1); } catch (e) { console.log("playlist.add failed: " + e); }
  if (added === false) { core.osd("Couldn't add to the playlist"); return; }
  core.osd(playNext ? countLabel(urls.length) + " will play next" : countLabel(urls.length) + " added");
  enqueueEnrich(urls); // fills in whatever the search didn't know (e.g. after the yt-dlp fallback)
  setTimeout(onPlaylistChanged, 150);
}

// Sort the actual playlist by a metadata key. This is destructive: it changes
// the real play order (so next/prev/auto-advance follow the sorted order).
function sortPlaylist(key, dir) {
  if (key === "order") return; // no stored "original" order to restore to
  let l;
  try { l = getRawPlaylist(); } catch (e) { return; }
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
    broadcastHotkeys();
    broadcastActivePlaylist();
  });
  surface.onMessage("ui:play", function (d) { if (d && typeof d.index === "number") playlist.play(d.index); });
  surface.onMessage("ui:queue-next", function (d) { if (d && typeof d.index === "number") queueNext(d.index); });
  surface.onMessage("ui:copy-next", function (d) { if (d && typeof d.index === "number") copyNext(d.index); });
  surface.onMessage("ui:playNext", function () { playlist.playNext(); });
  surface.onMessage("ui:playPrev", function () { playlist.playPrevious(); });
  surface.onMessage("ui:playpause", function () { togglePlayPause(); setTimeout(function () { broadcastTransport(true); }, 40); });
  surface.onMessage("ui:prev-smart", function () { smartPrevious(); });
  // A playback hotkey pressed inside the playlist webview; d.action is an HK_ACTIONS key.
  surface.onMessage("ui:hotkey", function (d) {
    if (d && HK_ACTIONS.hasOwnProperty(d.action)) HK_ACTIONS[d.action]();
  });
  surface.onMessage("ui:seek", function (d) {
    if (d && typeof d.pos === "number") {
      try { core.seekTo(d.pos); } catch (e) { }
      setTimeout(function () { broadcastProgress(); }, 60);
    }
  });
  surface.onMessage("ui:seek-rel", function (d) {
    if (d && typeof d.delta === "number") { try { core.seek(d.delta, false); } catch (e) { } setTimeout(function () { broadcastProgress(); }, 60); }
  });
  surface.onMessage("ui:cycle-repeat", function () { cycleLoop(); broadcastTransport(true); });
  surface.onMessage("ui:toggle-shuffle", function () { toggleShuffle(); broadcastTransport(true); });
  surface.onMessage("ui:volume", function (d) { if (d && typeof d.value === "number") { setVolume(d.value); broadcastTransport(true); } });
  surface.onMessage("ui:mute", function () { toggleMute(); broadcastTransport(true); });
  surface.onMessage("ui:remove", function (d) {
    if (d && d.indexes && d.indexes.length) { try { playlist.remove(d.indexes); } catch (e) { } setTimeout(onPlaylistChanged, 60); }
  });
  surface.onMessage("ui:move", function (d) {
    if (d && typeof d.from === "number" && typeof d.to === "number") moveItem(d.from, d.to);
  });
  surface.onMessage("ui:add", function () { addFiles(); });
  surface.onMessage("ui:addfolder", function () { addFolder(); });
  surface.onMessage("ui:addurl", function () {
    const url = utils.prompt("Add a URL — a single video or a playlist:");
    if (url) addUrl(url);
  });
  surface.onMessage("ui:ytm-search", function (d) {
    const query = String((d && d.query) || "").trim();
    if (query) searchYtMusic(surface, query, d.requestId);
  });
  surface.onMessage("ui:ytm-add", function (d) {
    if (d && d.tracks && d.tracks.length) addYtMusicTracks(d.tracks, !!d.playNext);
  });
  surface.onMessage("ui:clear", function () { clearPlaylist(); });
  surface.onMessage("ui:reveal", function (d) { if (d && d.path) { try { file.showInFinder(d.path); } catch (e) { } } });
  surface.onMessage("ui:save", function (d) { savePlaylist(d && d.name); });
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
    const l = getRawPlaylist();
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
// Show the playlist when the player opens ("showOnStart" preference:
// "off" | "sidebar" | "window"). The player window only appears once its first
// track is loaded, so this waits for that and then runs once per player.
// ---------------------------------------------------------------------------
const SHOW_ON_START_DELAY = 500; // ms for the player window to appear after the first load
let shownOnStart = false;

function showOnStartTarget() {
  try { return String(preferences.get("showOnStart") || "off"); } catch (e) { return "off"; }
}
// False in music mode: IINA hides the main window (and its sidebar) for audio
// and shows the mini player, which has no plugin tabs.
function mainWindowVisible() {
  try { return !!core.window.visible; } catch (e) { return false; }
}
function showPlaylistOnStart() {
  if (shownOnStart) return;
  shownOnStart = true;
  const target = showOnStartTarget();
  if (target === "sidebar" && mainWindowVisible()) {
    initSidebar();
    try { sidebar.show(); } catch (e) { console.log("show sidebar on start failed: " + e); }
  } else if (target === "sidebar" || target === "window") {
    openWindow();
  }
}

// ---------------------------------------------------------------------------
// mpv metadata for the current file — always authoritative.
// ---------------------------------------------------------------------------
let lastCurMetaSig = "";
function refreshCurrentMetadata() {
  try {
    const md = mpv.getNative("metadata") || {};
    const norm = {};
    for (const k in md) norm[String(k).toLowerCase()] = md[k];
    let list;
    try { list = getRawPlaylist(); } catch (e) { list = []; }
    const cur = list.filter(function (x) { return x.isCurrent; })[0] ||
                list.filter(function (x) { return x.isPlaying; })[0];
    if (!cur) return;
    const path = cur.filename;
    const entry = metaCache[path] || {};
    let title = norm["title"] || "";
    let artist = norm["artist"] || norm["album_artist"] || norm["albumartist"] || norm["uploader"] || norm["channel"] || "";
    let album = norm["album"] || "";

    // YouTube/ytdl streams usually carry no artist/album tags; the title arrives as
    // media-title, and (when present) the artist channel is often "Name - Topic".
    if (!title) {
      const mt = cleanStr(mpv.getString("media-title") || "");
      if (mt && mt !== path && mt !== baseName(path)) title = mt;
    }
    if (artist) artist = cleanStr(String(artist)).replace(/\s*-\s*Topic$/i, "");

    // Internet-radio streams often expose only "icy-title" as "Artist - Title".
    const icy = norm["icy-title"];
    if (icy) {
      const s = cleanStr(String(icy));
      const dash = s.indexOf(" - ");
      if (dash > 0 && !artist) { artist = s.slice(0, dash); if (!title) title = s.slice(dash + 3); }
      else if (!title) { title = s; }
    }

    // For LOCAL files our byte-level parser decodes Windows-1251 correctly, while
    // mpv may return mojibake — prefer the parser's result.
    if (!isNetwork(path)) {
      const tags = readTags(path);
      if (tags) {
        if (tags.title) title = tags.title;
        if (tags.artist) artist = tags.artist;
        if (tags.album) album = tags.album;
      }
    }

    if (title) entry.title = cleanStr(String(title));
    if (artist) entry.artist = cleanStr(String(artist));
    if (album) entry.album = cleanStr(String(album));
    const dur = mpv.getNumber("duration");
    if (dur && dur > 0) entry.duration = dur;
    entry.scanned = true;
    metaCache[path] = entry;

    // This also runs on a 1s poll (to catch live stream/ICY changes) — only push when changed.
    const sig = path + "|" + (entry.title || "") + "|" + (entry.artist || "") + "|" + (entry.album || "");
    if (sig === lastCurMetaSig) return;
    lastCurMetaSig = sig;
    postMeta(path, entry);
    persistCache();
    updateWindowTitle();
  } catch (e) { console.log("refreshCurrentMetadata: " + e); }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
loadCache();
refreshHotkeys(true); // register playback hotkeys for the main player window
setTimeout(restoreLastPlaylist, RESTORE_CHECK_DELAY);

event.on("iina.file-loaded", function () {
  onFileLoadedForPauseHold(); // first, so an unwanted resume is undone as early as possible
  flushPendingAdds();
  refreshCurrentMetadata(); scheduleState(); broadcastTransport(true); updateWindowTitle();
  if (!shownOnStart) setTimeout(showPlaylistOnStart, SHOW_ON_START_DELAY);
  // Lazily enrich the currently playing network track (YouTube etc.) via yt-dlp.
  try {
    const l = getRawPlaylist();
    const cur = l.filter(function (x) { return x.isCurrent; })[0];
    if (cur && isNetwork(cur.filename)) enqueueEnrich([cur.filename], true);
  } catch (e) { }
});
event.on("iina.file-started", function () { onFileStartedForPauseHold(); scheduleState(); broadcastTransport(true); });
event.on("mpv.pause.changed", function () { enforcePauseHold(); });
event.on("iina.window-will-close", function () { releasePauseHold(); });

// Keep the UI in sync with playlist changes made elsewhere (native list, drops, etc.),
// and bring the main window back if the playlist window was closed while it was hidden.
setInterval(function () {
  try {
    const sig = playlistSignature();
    if (sig !== lastSignature) { lastSignature = sig; onPlaylistChanged(); }
    if (weMinimized && !standaloneWindow.isOpen()) { applyMainHidden(false); } // restore, keep the pref
    broadcastTransport(); // reflect pause/loop changes made elsewhere (e.g. spacebar)
    refreshHotkeys();     // pick up hotkey edits made on the preferences page
    refreshAutoSaveState();
    refreshCurrentMetadata(); // catch live stream (ICY) metadata updates
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
