// Squeezebox Tap — trusted play engine.
//
// Dispatches a stored Tap PlaySpec straight to the native LMS primitives
// (`loadAlbum` for albums, `playTrack` play-now for single tracks). It is
// TRUSTED BY CONSTRUCTION: a Tap binding is created by an admin from a real
// search/library result, so the resolver replays it without re-running the
// guest-facing `spotifyTracksAreKnown` gate (that gate exists to stop guests
// injecting arbitrary Spotify URIs into the public queue — it does not apply to
// an admin-bound tag). This module never imports or calls that gate.

export async function playTapTarget(lms, playerId, playSpec) {
  if (!playerId) throw new Error("No active player to play the tap on");
  const kind = playSpec?.kind;

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
      return lms.playTrack(playerId, playSpec.track, "play-now");

    default:
      throw new Error(`Unknown Tap play kind: ${kind}`);
  }
}
