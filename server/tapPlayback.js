// Squeezebox Tap — trusted play engine.
//
// Dispatches a stored Tap PlaySpec straight to the native LMS primitives
// (`loadAlbum` for albums, `playTrack` for single tracks). It is TRUSTED BY
// CONSTRUCTION: a Tap binding is created by an admin from a real search/library
// result, so the resolver replays it without re-running the guest-facing
// `spotifyTracksAreKnown` gate. This module never imports or calls that gate.
//
// `policy` is the per-tag BEHAVIOR (how it plays, separate from what plays):
//   { playMode: "replace" | "queue", volume: number|null }
// - playMode "queue" adds a single-track tag to the queue instead of replacing
//   playback (album tags always replace — queuing a whole album is a future tier).
// - volume (0-100), when set, is applied by the resolver before playback.

export async function playTapTarget(lms, playerId, playSpec, policy = {}) {
  if (!playerId) throw new Error("No active player to play the tap on");
  const kind = playSpec?.kind;
  const queue = policy?.playMode === "queue";

  switch (kind) {
    case "album-from-top":
      return lms.loadAlbum(playerId, {
        source: playSpec.source,
        albumId: playSpec.albumId,
        albumUri: playSpec.albumUri,
        startIndex: undefined
      });

    case "album-from-track":
      return lms.loadAlbum(playerId, {
        source: playSpec.source,
        albumId: playSpec.albumId,
        albumUri: playSpec.albumUri,
        startIndex: playSpec.startIndex
      });

    case "track":
      return lms.playTrack(playerId, playSpec.track, queue ? "add-queue" : "play-now");

    default:
      throw new Error(`Unknown Tap play kind: ${kind}`);
  }
}
