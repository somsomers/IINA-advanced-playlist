// YouTube Music song search for the Advanced Playlist plugin.
//
// Primary source: YouTube Music's internal (unofficial) "InnerTube" search API —
// one request returns title, artist, album, duration and cover art. The request
// is made with curl, and the response is written to a @tmp file instead of
// stdout: iina.utils.exec decodes stdout chunk by chunk and silently drops a
// chunk that splits a multi-byte UTF-8 character, which corrupts large JSON.
//
// Fallback: yt-dlp's YouTube Music search. It only knows titles; artist/album
// are filled in by the playlist's yt-dlp enrichment after a track is added.

const { utils, file, console } = iina;

const CURL_PATH = "/usr/bin/curl";
const REQUEST_TIMEOUT_SEC = "15";
const SEARCH_ENDPOINT = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false";
const SEARCH_PAGE_URL = "https://music.youtube.com/search?q=";
const WATCH_URL_PREFIX = "https://music.youtube.com/watch?v=";
const MAX_FALLBACK_RESULTS = 20;

// Identifies the request as the YouTube Music web app. The version only has to
// look plausible; bump it if the API ever starts rejecting requests.
const CLIENT_NAME = "WEB_REMIX";
const CLIENT_VERSION = "1.20250101.01.00";
// The "Songs" search filter, exactly as the YouTube Music web app sends it.
const SONGS_FILTER_PARAMS = "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D";

// The details column reads "Artist[ & Artist] • Album • 3:59"; these runs split it.
const DETAILS_SEPARATOR = " • ";
const PAGE_TYPE_ALBUM = "MUSIC_PAGE_TYPE_ALBUM";
const DURATION_PATTERN = /^\d+(:\d{2}){1,2}$/;

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
// Safe nested lookup: dig(obj, ["a", 0, "b"]) → obj.a[0].b, or undefined.
function dig(obj, keys) {
  let current = obj;
  for (let i = 0; i < keys.length && current != null; i++) current = current[keys[i]];
  return current;
}

function parseDuration(text) {
  return text.split(":").reduce(function (total, part) { return total * 60 + Number(part); }, 0);
}

function watchUrl(videoId) { return WATCH_URL_PREFIX + videoId; }

// ---------------------------------------------------------------------------
// InnerTube request
// ---------------------------------------------------------------------------
function buildSearchBody(query) {
  return JSON.stringify({
    context: { client: { clientName: CLIENT_NAME, clientVersion: CLIENT_VERSION, hl: "en" } },
    query: query,
    params: SONGS_FILTER_PARAMS
  });
}

// Unique per request, so concurrent searches from several player windows never clash.
function makeTempResponsePath() {
  return "@tmp/ytmusic-search-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + ".json";
}

function deleteQuietly(path) {
  try { if (file.exists(path)) file.delete(path); } catch (e) { }
}

function readJsonFile(path) {
  return JSON.parse(file.read(path) || "");
}

function fetchSearchResponse(query) {
  const tmpPath = makeTempResponsePath();
  return utils.exec(CURL_PATH, [
    "--silent", "--show-error", "--fail", "--compressed",
    "--max-time", REQUEST_TIMEOUT_SEC,
    "--header", "Content-Type: application/json",
    "--header", "Origin: https://music.youtube.com",
    "--data-raw", buildSearchBody(query),
    "--output", utils.resolvePath(tmpPath),
    SEARCH_ENDPOINT
  ]).then(function (res) {
    try {
      if (!res || res.status !== 0) throw new Error("curl exited with " + (res && res.status) + ": " + (res && res.stderr));
      return readJsonFile(tmpPath);
    } finally {
      deleteQuietly(tmpPath);
    }
  });
}

// ---------------------------------------------------------------------------
// InnerTube response parsing
// ---------------------------------------------------------------------------
// Every song row of every result shelf in the response.
function extractSongRenderers(response) {
  const renderers = [];
  const tabs = dig(response, ["contents", "tabbedSearchResultsRenderer", "tabs"]) || [];
  tabs.forEach(function (tab) {
    const sections = dig(tab, ["tabRenderer", "content", "sectionListRenderer", "contents"]) || [];
    sections.forEach(function (section) {
      const shelfItems = dig(section, ["musicShelfRenderer", "contents"]) || [];
      shelfItems.forEach(function (item) {
        if (item.musicResponsiveListItemRenderer) renderers.push(item.musicResponsiveListItemRenderer);
      });
    });
  });
  return renderers;
}

function columnRuns(renderer, columnIndex) {
  return dig(renderer, ["flexColumns", columnIndex, "musicResponsiveListItemFlexColumnRenderer", "text", "runs"]) || [];
}

function joinRunTexts(runs) {
  return runs.map(function (run) { return run.text || ""; }).join("").trim();
}

function isAlbumRun(run) {
  return dig(run, ["navigationEndpoint", "browseEndpoint", "browseEndpointContextSupportedConfigs",
                   "browseEndpointContextMusicConfig", "pageType"]) === PAGE_TYPE_ALBUM;
}

// Split a column's runs into the groups between " • " separators.
function splitRunsBySeparator(runs) {
  const groups = [[]];
  runs.forEach(function (run) {
    if (run.text === DETAILS_SEPARATOR) groups.push([]);
    else groups[groups.length - 1].push(run);
  });
  return groups.filter(function (group) { return group.length > 0; });
}

// "Artist[ & Artist] • Album • 3:59" → { artist, album, duration }. The album is
// recognised by its link type and the duration by its shape; the first group is
// the artist(s). A single without an album simply has no album group.
function parseDetailRuns(runs) {
  const details = { artist: "", album: "", duration: 0 };
  splitRunsBySeparator(runs).forEach(function (group, index) {
    const text = joinRunTexts(group);
    if (group.some(isAlbumRun)) details.album = text;
    else if (DURATION_PATTERN.test(text)) details.duration = parseDuration(text);
    else if (index === 0) details.artist = text;
  });
  return details;
}

// The third column reads e.g. "2.3B plays" (English, since requests use hl=en).
// Returns the abbreviated count ("2.3B"), or "" when the column holds something else.
const PLAYS_SUFFIX = /\s*plays?$/i;
function parsePlays(runs) {
  const text = joinRunTexts(runs);
  return PLAYS_SUFFIX.test(text) ? text.replace(PLAYS_SUFFIX, "") : "";
}

// The largest of the (small) thumbnails the search returns — sharp on Retina.
function thumbnailUrl(renderer) {
  const thumbs = dig(renderer, ["thumbnail", "musicThumbnailRenderer", "thumbnail", "thumbnails"]) || [];
  return thumbs.length ? thumbs[thumbs.length - 1].url : "";
}

function parseSongRenderer(renderer) {
  const videoId = dig(renderer, ["playlistItemData", "videoId"]);
  const title = joinRunTexts(columnRuns(renderer, 0));
  if (!videoId || !title) return null; // e.g. a track that is unavailable in this region
  const details = parseDetailRuns(columnRuns(renderer, 1));
  return {
    url: watchUrl(videoId),
    title: title,
    artist: details.artist,
    album: details.album,
    duration: details.duration,
    plays: parsePlays(columnRuns(renderer, 2)),
    thumbnail: thumbnailUrl(renderer)
  };
}

function parseSearchResponse(response) {
  return extractSongRenderers(response).map(parseSongRenderer).filter(Boolean);
}

// An empty result is treated as a failure too: when YouTube changes the response
// format, parsing yields nothing, and the yt-dlp fallback should take over.
function searchWithApi(query) {
  return fetchSearchResponse(query).then(function (response) {
    const tracks = parseSearchResponse(response);
    if (!tracks.length) throw new Error("no songs in the API response");
    return tracks;
  });
}

// ---------------------------------------------------------------------------
// yt-dlp fallback
// ---------------------------------------------------------------------------
function parseYtdlpLine(line) {
  const tab = line.indexOf("\t");
  const videoId = (tab >= 0 ? line.slice(0, tab) : line).trim();
  const title = tab >= 0 ? line.slice(tab + 1).trim() : "";
  if (!videoId) return null;
  return { url: watchUrl(videoId), title: title === "NA" ? "" : title, artist: "", album: "", duration: 0, plays: "", thumbnail: "" };
}

function searchWithYtdlp(query, ytdlpPath) {
  const searchUrl = SEARCH_PAGE_URL + encodeURIComponent(query) + "#songs";
  return utils.exec(ytdlpPath, ["--flat-playlist", "--playlist-end", String(MAX_FALLBACK_RESULTS),
                                "--print", "%(id)s\t%(title|)s", searchUrl])
    .then(function (res) {
      if (!res || res.status !== 0) throw new Error("yt-dlp exited with " + (res && res.status));
      return (res.stdout || "").split("\n").map(parseYtdlpLine).filter(Boolean);
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// Resolves to { tracks, titlesOnly } where each track is
// { url, title, artist, album, duration, plays, thumbnail } (`plays` is an
// abbreviated count such as "2.3B", or ""). `titlesOnly` is true when
// the yt-dlp fallback answered. `ytdlpPath` may be null (no fallback then).
function searchSongs(query, ytdlpPath) {
  return searchWithApi(query)
    .then(function (tracks) { return { tracks: tracks, titlesOnly: false }; })
    .catch(function (apiError) {
      console.log("YouTube Music API search failed: " + apiError);
      if (!ytdlpPath) throw apiError;
      return searchWithYtdlp(query, ytdlpPath)
        .then(function (tracks) { return { tracks: tracks, titlesOnly: true }; });
    });
}

module.exports = { searchSongs: searchSongs };
