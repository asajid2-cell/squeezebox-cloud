import { describe, expect, it } from "vitest";
import { rankRecommendationCandidates, recommendationSeedArtists, scoreRecommendationCandidate } from "../server/recommender.js";

const now = Date.parse("2026-06-11T12:00:00.000Z");

function aggregate(name: string, score: number, lastAt = "2026-06-01T12:00:00.000Z", extra = {}) {
  return {
    key: name.toLowerCase(),
    name,
    plays: 4,
    skips: 0,
    completes: 3,
    replays: 1,
    playedSeconds: 900,
    score,
    firstAt: "2026-05-01T12:00:00.000Z",
    lastAt,
    ...extra
  };
}

describe("shared recommender ranker", () => {
  it("uses now-playing and shared top artists as seed artists", () => {
    const tasteState = {
      listeners: {
        ambient: {
          artists: {
            "loved artist": aggregate("Loved Artist", 8),
            "quiet artist": aggregate("Quiet Artist", 2)
          }
        },
        kitchen: {
          artists: {
            "second artist": aggregate("Second Artist", 6)
          }
        }
      }
    };

    expect(recommendationSeedArtists(tasteState, { artist: "Current Artist" }, "Manual Seed", 4)).toEqual([
      "Current Artist",
      "Manual Seed",
      "Loved Artist",
      "Second Artist"
    ]);
  });

  it("ranks affinity plus exploration above recent repeats and hard-skip history", () => {
    const tasteState = {
      listeners: {
        ambient: {
          artists: {
            "loved artist": aggregate("Loved Artist", 10),
            "skipped artist": aggregate("Skipped Artist", -4, "2026-06-01T12:00:00.000Z", { skips: 4, completes: 0, score: -4 })
          },
          albums: {
            "loved album": aggregate("Loved Album", 3)
          },
          tracks: {
            "spotify:track:recent": aggregate("Recent Track", 7, "2026-06-11T11:30:00.000Z", { track: { uri: "spotify:track:recent" } }),
            "spotify:track:skipped": aggregate("Skipped Track", -3, "2026-06-01T12:00:00.000Z", { skips: 3, completes: 0, score: -3 })
          }
        }
      }
    };
    const candidates = [
      { title: "Recent Track", artist: "Loved Artist", album: "Loved Album", uri: "spotify:track:recent", source: "Spotify", kind: "track" },
      { title: "Fresh Loved", artist: "Loved Artist", album: "Loved Album", uri: "spotify:track:fresh-loved", source: "Spotify", kind: "track" },
      { title: "Unknown Fresh", artist: "Unknown Artist", album: "Unknown Album", uri: "spotify:track:unknown", source: "Spotify", kind: "track" },
      { title: "Skipped Track", artist: "Skipped Artist", album: "Bad Album", uri: "spotify:track:skipped", source: "Spotify", kind: "track" }
    ];

    const ranked = rankRecommendationCandidates(candidates, {
      tasteState,
      nowPlaying: { title: "Current", artist: "Current Artist", uri: "spotify:track:current" },
      history: [],
      queue: [],
      limit: 4,
      now
    });

    expect(ranked.map((track) => track.title)).toEqual([
      "Fresh Loved",
      "Unknown Fresh",
      "Recent Track",
      "Skipped Track"
    ]);
    expect(scoreRecommendationCandidate(candidates[1], { tasteState, now })).toBeGreaterThan(
      scoreRecommendationCandidate(candidates[2], { tasteState, now })
    );
  });
});
