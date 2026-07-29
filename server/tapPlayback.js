// Squeezebox Tap — trusted play engine.
//
// Dispatches a stored Tap PlaySpec straight to the native LMS primitives
// (`loadAlbum` for albums, `loadPlaylist` for playlists, `playTrack` for single
// tracks). It is TRUSTED BY CONSTRUCTION: a Tap binding is created by an admin
// from a real search/library result, so the resolver replays it without
// re-running the guest-facing `spotifyTracksAreKnown` gate. This module never
// imports or calls that gate.
//
// `behavior` is the resolved per-tap BEHAVIOR (how it plays, separate from what
// plays) — the play handler folds the per-tag policy AND the global party-queue
// switch into it before calling here:
//   { playMode: "replace" | "queue", resumeTo: { index, seconds } | null }
// - playMode "queue" ADDS to the queue instead of replacing playback (tracks,
//   albums, and playlists all support append).
// - resumeTo, when set, plays an album from a saved bookmark (index + seek) so a
//   resume-enabled tag picks up where it left off. Ignored in queue mode and for
//   non-album kinds.
//
// The "discover" kind is NOT handled here — it needs the recommender + listener
// taste + appState, so the play handler resolves it directly.

export async function playTapTarget(lms, playerId, playSpec, behavior = {}) {
  if (!playerId) throw new Error("No active player to play the tap on");
  const kind = playSpec?.kind;
  const queue = behavior?.playMode === "queue";
  const resumeTo = !queue && behavior?.resumeTo ? behavior.resumeTo : null;

  switch (kind) {
    case "album-from-top":
    case "album-from-track": {
      const startIndex = resumeTo
        ? resumeTo.index
        : kind === "album-from-track"
          ? playSpec.startIndex
          : undefined;
      const result = await lms.loadAlbum(playerId, {
        source: playSpec.source,
        albumId: playSpec.albumId,
        albumUri: playSpec.albumUri,
        startIndex,
        queue
      });
      // Resuming: jump to the saved elapsed position. Best-effort — the album may
      // still be streaming in, so a failed seek must not fail the whole tap.
      if (resumeTo && resumeTo.seconds > 0) {
        await lms.control(playerId, "seek", resumeTo.seconds).catch(() => {});
      }
      return result;
    }

    case "playlist":
      return lms.loadPlaylist(playerId, { source: playSpec.source, playlistUri: playSpec.playlistUri, queue });

    case "track":
      return lms.playTrack(playerId, playSpec.track, queue ? "add-queue" : "play-now");

    default:
      throw new Error(`Unknown Tap play kind: ${kind}`);
  }
}
