import { listenerTrackKey } from "./listenerTaste.js";

const DEFAULT_LIMIT = 5;
const MAX_SEED_ARTISTS = 6;
const TRACK_RECENT_MS = 18 * 60 * 60 * 1000;
const ARTIST_RECENT_MS = 90 * 60 * 1000;
const ARTIST_SATIATION_MS = 6 * 60 * 60 * 1000;

export function recommendationSeedArtists(tasteState = {}, nowPlaying = {}, seed = "", limit = MAX_SEED_ARTISTS) {
  const profile = sharedTasteProfile(tasteState);
  const seeds = [
    nowPlaying?.artist,
    seed,
    ...Object.values(profile.artists)
      .sort((left, right) => (right.score || 0) - (left.score || 0) || String(right.lastAt || "").localeCompare(String(left.lastAt || "")))
      .map((artist) => artist.name)
  ];
  return uniqueNames(seeds).slice(0, Math.max(1, limit));
}

export function rankRecommendationCandidates(candidates = [], options = {}) {
  const limit = Math.max(1, Number(options.limit) || DEFAULT_LIMIT);
  const profile = sharedTasteProfile(options.tasteState || {});
  const now = Number(options.now) || Date.now();
  const queueKeys = new Set((options.queue || []).map(candidateKey).filter(Boolean));
  const historyKeys = new Set((options.history || []).map((item) => String(item || "").toLowerCase()).filter(Boolean));
  const currentKey = candidateKey(options.nowPlaying);
  const nowArtist = normalizeName(options.nowPlaying?.artist);

  return uniqueCandidates(candidates)
    .filter((candidate) => {
      const key = candidateKey(candidate);
      return key && key !== currentKey && !queueKeys.has(key);
    })
    .map((candidate, index) => {
      const score = scoreRecommendationCandidate(candidate, {
        profile,
        now,
        historyKeys,
        nowArtist,
        index
      });
      return { candidate, score };
    })
    .filter((item) => item.score > -2.5)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.candidate);
}

export function scoreRecommendationCandidate(candidate = {}, options = {}) {
  const profile = options.profile || sharedTasteProfile(options.tasteState || {});
  const now = Number(options.now) || Date.now();
  const track = profile.tracks[candidateKey(candidate)] || null;
  const artist = profile.artists[normalizeName(candidate.artist)] || null;
  const album = profile.albums[normalizeName(candidate.album)] || null;

  const trackScore = normalizedAggregateScore(track, 4);
  const artistScore = normalizedAggregateScore(artist, 8);
  const albumScore = normalizedAggregateScore(album, 5);
  const affinity = (0.55 * artistScore) + (0.30 * trackScore) + (0.15 * albumScore);

  const exploration =
    (track ? 0 : 0.35) +
    (artist ? 0 : 0.18) +
    (album ? 0 : 0.07);

  const repetition =
    trackRecencyPenalty(track, now) +
    artistRecencyPenalty(artist, now) +
    skipPenalty(track) +
    shuffleHistoryPenalty(candidate, options.historyKeys) +
    sameArtistPenalty(candidate, options.nowArtist);

  const orderTieBreak = -0.0001 * (Number(options.index) || 0);
  return affinity + exploration - repetition + orderTieBreak;
}

export function sharedTasteProfile(tasteState = {}) {
  const shared = { tracks: {}, artists: {}, albums: {}, sources: {}, seeds: {}, events: [] };
  for (const listener of Object.values(tasteState.listeners || {})) {
    mergeAggregateMap(shared.tracks, listener.tracks || {});
    mergeAggregateMap(shared.artists, listener.artists || {});
    mergeAggregateMap(shared.albums, listener.albums || {});
    mergeAggregateMap(shared.sources, listener.sources || {});
    mergeAggregateMap(shared.seeds, listener.seeds || {});
  }
  shared.events = Array.isArray(tasteState.events) ? tasteState.events.slice(-500) : [];
  return shared;
}

function mergeAggregateMap(target, source) {
  for (const [key, item] of Object.entries(source || {})) {
    const existing = target[key] || {
      ...item,
      plays: 0,
      skips: 0,
      completes: 0,
      replays: 0,
      playedSeconds: 0,
      score: 0,
      firstAt: item.firstAt,
      lastAt: item.lastAt
    };
    existing.name = existing.name || item.name;
    existing.track = existing.track || item.track;
    existing.plays += Number(item.plays) || 0;
    existing.skips += Number(item.skips) || 0;
    existing.completes += Number(item.completes) || 0;
    existing.replays += Number(item.replays) || 0;
    existing.playedSeconds += Number(item.playedSeconds) || 0;
    existing.score += Number(item.score) || 0;
    existing.firstAt = earliestIso(existing.firstAt, item.firstAt);
    existing.lastAt = latestIso(existing.lastAt, item.lastAt);
    target[key] = existing;
  }
}

function normalizedAggregateScore(item, scale) {
  if (!item) return 0;
  const raw = Number(item.score) || 0;
  const confidence = Math.min(1, Math.log1p(Number(item.plays || 0) + Number(item.completes || 0) + Number(item.replays || 0) + Number(item.skips || 0)) / Math.log(8));
  return Math.tanh(raw / scale) * (0.35 + 0.65 * confidence);
}

function trackRecencyPenalty(track, now) {
  if (!track?.lastAt) return 0;
  const age = now - Date.parse(track.lastAt);
  if (!Number.isFinite(age) || age < 0) return 0;
  if (age < TRACK_RECENT_MS) return 2.25;
  if (age < 3 * TRACK_RECENT_MS) return 0.7;
  return 0;
}

function artistRecencyPenalty(artist, now) {
  if (!artist?.lastAt) return 0;
  const age = now - Date.parse(artist.lastAt);
  if (!Number.isFinite(age) || age < 0) return 0;
  if (age < ARTIST_RECENT_MS) return 0.9;
  if (age < ARTIST_SATIATION_MS) return 0.35;
  return 0;
}

function skipPenalty(track) {
  if (!track) return 0;
  const skips = Number(track.skips) || 0;
  const completes = Number(track.completes) || 0;
  if (skips <= completes) return 0;
  return Math.min(2.2, 0.75 + (skips - completes) * 0.45);
}

function shuffleHistoryPenalty(candidate, historyKeys = new Set()) {
  const key = candidateKey(candidate);
  return key && historyKeys.has(key) ? 1.4 : 0;
}

function sameArtistPenalty(candidate, nowArtist) {
  const artist = normalizeName(candidate.artist);
  return artist && nowArtist && artist === nowArtist ? 0.2 : 0;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return (candidates || []).filter((candidate) => {
    const key = candidateKey(candidate) || `${normalizeName(candidate.title)}:${normalizeName(candidate.artist)}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateKey(candidate) {
  return listenerTrackKey(candidate || {});
}

function uniqueNames(values) {
  const seen = new Set();
  return values
    .map((value) => String(value || "").trim())
    .filter((value) => {
      const key = normalizeName(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function earliestIso(left, right) {
  if (!left) return right || "";
  if (!right) return left;
  return String(left) < String(right) ? left : right;
}

function latestIso(left, right) {
  if (!left) return right || "";
  if (!right) return left;
  return String(left) > String(right) ? left : right;
}
