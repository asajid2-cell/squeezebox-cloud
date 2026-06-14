// Squeezebox Tap — PlaySpec construction + validation.
//
// A PlaySpec is the canonical, storable description of what a tag plays. Three
// kinds (Spotify-first; local albums use an LMS album_id when available):
//   { kind: "album-from-top",   source, albumUri | albumId }
//   { kind: "album-from-track", source, albumUri | albumId, startIndex }
//   { kind: "track",            track }
//
// album-from-track ("start the album at the representative song") cannot be
// derived from an arbitrary Spotify track (Spotty only exposes the track URI,
// not its parent album). It is built by picking the song from an album's ORDERED
// track list, which yields both the album URI and the 0-based startIndex. So the
// builder REQUIRES an explicit album reference + startIndex and never silently
// degrades album-from-track into album-from-top.
import { z } from "zod";

const spotifyAlbumUri = z
  .string()
  .regex(/^spotify:album:[A-Za-z0-9]+$/i, "expected a spotify:album:<id> URI");

const spotifyPlaylistUri = z
  .string()
  .regex(/^spotify:playlist:[A-Za-z0-9]+$/i, "expected a spotify:playlist:<id> URI");

const localAlbumId = z.string().min(1);
const libraryPlaylistId = z.string().min(1);
const startIndex = z.number().int().nonnegative();
// A discovery tag's optional theming seed (artist/genre text); empty => pure taste.
const discoverSeed = z.string().max(120).optional();

const trackInput = z
  .object({
    id: z.string().optional(),
    uri: z.string().optional(),
    path: z.string().optional(),
    lmsTrackId: z.union([z.string(), z.number()]).optional(),
    title: z.string().optional(),
    artist: z.string().optional(),
    album: z.string().optional(),
    source: z.string().optional(),
    art: z.string().nullable().optional(),
    duration: z.number().nullable().optional()
  })
  .passthrough()
  .refine(
    (t) => Boolean(t.uri || t.path || t.lmsTrackId || (t.id && /^(local:|archive:)/.test(String(t.id)))),
    { message: "track needs a playable reference (uri, path, lmsTrackId, or local/archive id)" }
  );

const playSpecSchema = z.union([
  z.object({ kind: z.literal("album-from-top"), source: z.literal("spotify"), albumUri: spotifyAlbumUri }),
  z.object({ kind: z.literal("album-from-top"), source: z.literal("local"), albumId: localAlbumId }),
  z.object({ kind: z.literal("album-from-track"), source: z.literal("spotify"), albumUri: spotifyAlbumUri, startIndex }),
  z.object({ kind: z.literal("album-from-track"), source: z.literal("local"), albumId: localAlbumId, startIndex }),
  z.object({ kind: z.literal("track"), track: trackInput }),
  // A whole Spotify playlist plays start-to-finish (colon form, like albums).
  z.object({ kind: z.literal("playlist"), source: z.literal("spotify"), playlistUri: spotifyPlaylistUri }),
  // A "surprise me" tag: every tap resolves a FRESH pick from the taste-seeded
  // recommender at play time, so it stores no fixed target — only an optional seed.
  z.object({ kind: z.literal("discover"), source: z.literal("spotify"), seed: discoverSeed }),
  // A tag bound to one of OUR app-managed (library) playlists — plays its saved
  // tracks. The playlist is editable in the Library, so the tag follows it.
  z.object({ kind: z.literal("library"), playlistId: libraryPlaylistId })
]);

export function validatePlaySpec(spec) {
  const result = playSpecSchema.safeParse(spec);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error };
}

// Build a canonical PlaySpec from a binder selection + intent. Throws (with a
// human-readable reason) on any impossible combination so the binder can't
// persist an unplayable tag.
export function buildPlaySpec(input = {}) {
  const intent = input?.intent;

  if (intent === "track") {
    const parsed = trackInput.safeParse(input.track || {});
    if (!parsed.success) {
      throw new Error("Track binding needs a playable reference (uri, path, lmsTrackId, or local/archive id)");
    }
    return { kind: "track", track: input.track };
  }

  if (intent === "playlist") {
    if (input.source !== "spotify") {
      throw new Error("Playlist binding currently supports Spotify playlists only");
    }
    if (!/^spotify:playlist:[A-Za-z0-9]+$/i.test(String(input.playlistUri || ""))) {
      throw new Error("expected a spotify:playlist:<id> URI");
    }
    return { kind: "playlist", source: "spotify", playlistUri: input.playlistUri };
  }

  if (intent === "discover") {
    const seed = String(input.seed || "").trim();
    const spec = { kind: "discover", source: "spotify" };
    if (seed) spec.seed = seed.slice(0, 120);
    return spec;
  }

  if (intent === "library") {
    const playlistId = String(input.playlistId || "").trim();
    if (!playlistId) throw new Error("A library playlist binding needs a playlistId");
    return { kind: "library", playlistId };
  }

  if (intent === "album-from-top" || intent === "album-from-track") {
    const source = input.source;
    let spec;
    if (source === "spotify") {
      if (!input.albumUri) throw new Error("Album playback needs an album reference (a spotify:album: URI)");
      if (!/^spotify:album:[A-Za-z0-9]+$/i.test(String(input.albumUri))) {
        throw new Error("expected a spotify:album:<id> URI");
      }
      spec = { kind: intent, source: "spotify", albumUri: input.albumUri };
    } else if (source === "local") {
      if (!input.albumId) throw new Error("Album playback needs an album reference (an LMS album_id)");
      spec = { kind: intent, source: "local", albumId: String(input.albumId) };
    } else {
      throw new Error("Album playback needs a source of 'spotify' or 'local'");
    }

    if (intent === "album-from-track") {
      const idx = Number(input.startIndex);
      if (!Number.isInteger(idx) || idx < 0) {
        throw new Error("album-from-track needs a non-negative in-album start index");
      }
      spec.startIndex = idx;
    }

    const validated = validatePlaySpec(spec);
    if (!validated.ok) throw new Error("Constructed PlaySpec failed validation");
    return spec;
  }

  throw new Error(`Unknown Tap intent: ${intent}`);
}
