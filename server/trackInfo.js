const cache = new Map();

export async function enrichTrackInfo(track) {
  const parsed = parseTrack(track);
  const key = `${parsed.artist}::${parsed.title}`.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  if (process.env.VITEST && !process.env.TRACK_INFO_ALLOW_NETWORK_IN_TESTS) {
    return fallbackInfo(parsed);
  }

  const [musicBrainz, artistSummary, lyrics, artwork] = await Promise.all([
    fetchMusicBrainz(parsed),
    fetchArtistSummary(parsed.artist),
    fetchLyrics(parsed),
    fetchArtwork(parsed)
  ]);
  const info = {
    artistBio:
      artistSummary || musicBrainz.artistBio || fallbackInfo(parsed).artistBio,
    albumReview:
      musicBrainz.albumReview || artwork.albumReview || fallbackInfo(parsed).albumReview,
    lyrics:
      lyrics || fallbackInfo(parsed).lyrics,
    art: artwork.art || musicBrainz.art || null
  };
  cache.set(key, info);
  return info;
}

function fallbackInfo(parsed) {
  return {
    artistBio: `${parsed.artist} is the detected artist for "${parsed.title}".`,
    albumReview: `No album metadata was found automatically for "${parsed.title}".`,
    lyrics: `No synced lyrics were found automatically for "${parsed.title}" by ${parsed.artist}. Try a cleaner artist/title tag for better matching.`
  };
}

export function parseTrack(track = {}) {
  let title = clean(track.title || "Unknown title");
  let artist = clean(track.artist || "");

  const filenameMatch = title.match(/^\s*([^-]+?)\s+-\s+(.+)$/);
  if ((!artist || /^no artist|unknown artist$/i.test(artist)) && filenameMatch) {
    artist = clean(filenameMatch[1]);
    title = clean(filenameMatch[2]);
  }

  title = title.replace(/\s*\((official|lyrics?|audio|visualizer|unreleased|og|extended)[^)]*\)/gi, "").trim() || title;
  artist = artist || "Unknown artist";
  return { title, artist };
}

async function fetchMusicBrainz({ artist, title }) {
  try {
    const url = new URL("https://musicbrainz.org/ws/2/recording/");
    url.searchParams.set("query", `artist:${artist} AND recording:${title}`);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "1");
    const response = await fetch(url, {
      headers: { "user-agent": "SqueezeboxCloud/0.1 (harmonizerlabs.cc)" },
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) return {};
    const data = await response.json();
    const recording = data.recordings?.[0];
    const release = recording?.releases?.[0];
    return {
      artistBio: recording
        ? `${artist} - ${recording.title}. MusicBrainz match confidence: ${recording.score ?? "unknown"}.`
        : "",
      albumReview: release ? `${release.title}${release.date ? ` (${release.date})` : ""}.` : "",
      art: release?.id ? `https://coverartarchive.org/release/${release.id}/front-500` : null
    };
  } catch {
    return {};
  }
}

async function fetchLyrics({ artist, title }) {
  const lrclib = await fetchLrclibLyrics({ artist, title });
  if (lrclib) return lrclib;
  try {
    const response = await fetch(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
      { signal: AbortSignal.timeout(2500) }
    );
    if (!response.ok) return "";
    const data = await response.json();
    return clean(data.lyrics || "").slice(0, 1200);
  } catch {
    return "";
  }
}

async function fetchLrclibLyrics({ artist, title }) {
  try {
    const url = new URL("https://lrclib.net/api/search");
    url.searchParams.set("artist_name", artist);
    url.searchParams.set("track_name", title);
    const response = await fetch(url, {
      headers: { "user-agent": "SqueezeboxCloud/0.1 (harmonizerlabs.cc)" },
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) return "";
    const results = await response.json();
    const match = Array.isArray(results) ? results[0] : null;
    return clean(match?.plainLyrics || match?.syncedLyrics || "").slice(0, 1200);
  } catch {
    return "";
  }
}

async function fetchArtistSummary(artist) {
  const candidates = [
    artist,
    `${artist} (musician)`,
    `${artist} (rapper)`,
    `${artist} (singer)`,
    `${artist} (band)`
  ];
  for (const candidate of candidates) {
    try {
      const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(candidate)}`, {
        headers: { "user-agent": "SqueezeboxCloud/0.1 (harmonizerlabs.cc)" },
        signal: AbortSignal.timeout(2500)
      });
      if (!response.ok) continue;
      const data = await response.json();
      const summary = clean(data.extract || "").slice(0, 900);
      if (!summary || isDisambiguationSummary(summary, artist)) continue;
      return summary;
    } catch {
      // Try the next music-specific candidate.
    }
  }
  return "";
}

function isDisambiguationSummary(summary, artist) {
  const value = summary.toLowerCase();
  const name = clean(artist).toLowerCase();
  return value.startsWith(`${name} may refer to`) || value.includes("may refer to:");
}

async function fetchArtwork({ artist, title }) {
  try {
    const url = new URL("https://itunes.apple.com/search");
    url.searchParams.set("term", `${artist} ${title}`);
    url.searchParams.set("media", "music");
    url.searchParams.set("entity", "song");
    url.searchParams.set("limit", "1");
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return {};
    const data = await response.json();
    const result = data.results?.[0];
    return {
      art: result?.artworkUrl100 ? result.artworkUrl100.replace(/100x100bb/, "600x600bb") : null,
      albumReview: result?.collectionName ? `${result.collectionName}${result.releaseDate ? ` (${String(result.releaseDate).slice(0, 10)})` : ""}.` : ""
    };
  } catch {
    return {};
  }
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
