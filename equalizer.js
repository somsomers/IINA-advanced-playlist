// Advanced Playlist — 10-band audio equalizer
//
// The equalizer is an mpv audio filter: a lavfi graph of ffmpeg "equalizer"
// peaking filters, one per band — the same filter IINA's own equalizer builds.
// It carries its own label, so it never replaces IINA's equalizer or other
// user filters, and re-adding it under that label updates it in place.

const { mpv, preferences, console } = iina;

const FILTER_LABEL = "@playlist_pro_eq";
const BAND_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const MAX_GAIN_DB = 12;
// Bandwidth of each band in Hz (f / sqrt(1.5)) — matches IINA's equalizer.
const BANDWIDTH_DIVISOR = 1.224744871;

// Preset gains (dB) per band, taken from IINA's built-in equalizer presets.
const PRESETS = {
  flat: { name: "Flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  acoustic: { name: "Acoustic", gains: [5, 4.9, 3.95, 1.05, 2.15, 1.75, 3.5, 4.1, 3.55, 2.15] },
  bass: { name: "Bass Boost", gains: [5.5, 4.25, 3.5, 2.5, 1.25, 0, 0, 0, 0, 0] },
  classical: { name: "Classical", gains: [4.75, 3.75, 3, 2.5, -1.5, -1.5, 0, 2.25, 3.25, 3.75] },
  dance: { name: "Dance", gains: [3.57, 6.55, 4.99, 0, 1.92, 3.65, 5.15, 4.54, 3.59, 0] },
  electronic: { name: "Electronic", gains: [4.25, 3.8, 1.2, 0, -2.15, 2.25, 0.85, 1.25, 3.95, 4.8] },
  hipHop: { name: "Hip-Hop", gains: [5, 4.25, 1.5, 3, -1, -1, 1.5, -0.5, 2, 3] },
  jazz: { name: "Jazz", gains: [4, 3, 1.5, 2.25, -1.5, -1.5, 0, 1.5, 3, 3.75] },
  pop: { name: "Pop", gains: [-1.5, -1, 0, 2, 4, 4, 2, 0, -1, -1.5] },
  rock: { name: "Rock", gains: [5, 4, 3, 1.5, -0.5, -1, 0.5, 2.5, 3.5, 4.5] },
  treble: { name: "Treble Boost", gains: [0, 0, 0, 0, 0, 1.25, 2.5, 3.5, 4.25, 5.5] },
  vocal: { name: "Vocal", gains: [-1.5, -3, -3, 1.5, 3.75, 3.75, 3, 1.5, 0, -1.5] }
};
// Preset key shown once the user moves a band by hand.
const CUSTOM_PRESET = "custom";

// ---------------------------------------------------------------------------
// State: { enabled, expanded, preset, gains[10] }
// ---------------------------------------------------------------------------
function clampGain(value) {
  const gain = Number(value);
  if (!isFinite(gain)) return 0;
  return Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, Math.round(gain * 10) / 10));
}

function normalizeGains(gains) {
  return BAND_FREQUENCIES.map(function (_, band) { return clampGain(gains && gains[band]); });
}

function isKnownPreset(key) {
  return key === CUSTOM_PRESET || PRESETS.hasOwnProperty(key);
}

function presetGains(key) {
  return PRESETS[key].gains.slice();
}

// Gains are stored as a comma-separated string: preference values are plain scalars.
function parseStoredGains(text) {
  return normalizeGains(String(text || "").split(","));
}

function readPreference(key, fallback) {
  try {
    const value = preferences.get(key);
    return value == null ? fallback : value;
  } catch (e) { return fallback; }
}

function loadState() {
  const preset = String(readPreference("eqPreset", "flat"));
  return {
    enabled: !!readPreference("eqEnabled", false),
    expanded: !!readPreference("eqExpanded", false),
    preset: isKnownPreset(preset) ? preset : CUSTOM_PRESET,
    gains: parseStoredGains(readPreference("eqGains", ""))
  };
}

function saveState(state) {
  try {
    preferences.set("eqEnabled", state.enabled);
    preferences.set("eqExpanded", state.expanded);
    preferences.set("eqPreset", state.preset);
    preferences.set("eqGains", state.gains.join(","));
    preferences.sync();
  } catch (e) { console.log("equalizer: saving state failed: " + e); }
}

// ---------------------------------------------------------------------------
// mpv filter
// ---------------------------------------------------------------------------
function bandFilter(frequency, gain) {
  const width = frequency / BANDWIDTH_DIVISOR;
  return "equalizer=f=" + frequency + ":t=h:width=" + width + ":g=" + gain;
}

function buildFilter(gains) {
  const bands = BAND_FREQUENCIES.map(function (frequency, band) { return bandFilter(frequency, gains[band]); });
  return FILTER_LABEL + ":lavfi=[" + bands.join(",") + "]";
}

function isFlat(gains) {
  return gains.every(function (gain) { return gain === 0; });
}

// Remove-when-absent is harmless; errors are logged by mpv, not thrown.
function removeFilter() {
  try { mpv.command("af", ["remove", FILTER_LABEL]); } catch (e) { }
}

// A flat curve changes nothing, so it is removed instead of costing CPU.
function applyToPlayer(state) {
  if (!state.enabled || isFlat(state.gains)) { removeFilter(); return; }
  try { mpv.command("af", ["add", buildFilter(state.gains)]); }
  catch (e) { console.log("equalizer: applying filter failed: " + e); }
}

// ---------------------------------------------------------------------------
// Public API — each change returns the new state; the caller persists,
// applies and broadcasts it.
// ---------------------------------------------------------------------------
function withEnabled(state, enabled) {
  return Object.assign({}, state, { enabled: !!enabled });
}

function withExpanded(state, expanded) {
  return Object.assign({}, state, { expanded: !!expanded });
}

// Moving a band by hand turns the equalizer on and switches to the custom preset.
function withBandGain(state, band, gain) {
  if (!(band >= 0 && band < BAND_FREQUENCIES.length)) return state;
  const gains = state.gains.slice();
  gains[band] = clampGain(gain);
  return Object.assign({}, state, { enabled: true, preset: CUSTOM_PRESET, gains: gains });
}

function withPreset(state, key) {
  if (!PRESETS.hasOwnProperty(key)) return state;
  return Object.assign({}, state, { enabled: true, preset: key, gains: presetGains(key) });
}

// What the UI needs to draw the panel (static data included, so the UI has no copy of it).
function describe(state) {
  const presets = Object.keys(PRESETS).map(function (key) { return { key: key, name: PRESETS[key].name }; });
  return {
    enabled: state.enabled, expanded: state.expanded, preset: state.preset, gains: state.gains,
    frequencies: BAND_FREQUENCIES, maxGain: MAX_GAIN_DB, presets: presets
  };
}

module.exports = {
  loadState: loadState,
  saveState: saveState,
  applyToPlayer: applyToPlayer,
  withEnabled: withEnabled,
  withExpanded: withExpanded,
  withBandGain: withBandGain,
  withPreset: withPreset,
  describe: describe
};
