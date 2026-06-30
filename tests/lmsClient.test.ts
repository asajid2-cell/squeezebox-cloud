import { describe, expect, it } from "vitest";
import net from "node:net";
import path from "node:path";
import { LmsClient, isCommandPayload, lastToken } from "../server/lmsClient.js";
import { config } from "../server/state.js";

describe("LMS client parsing", () => {
  it("extracts the final CLI token", () => {
    expect(lastToken("player count 1")).toBe("1");
    expect(lastToken("00%3A04 name Living%20Room")).toBe("Living%20Room");
  });

  it("resolves LMS CLI responses that do not end with a newline", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.write("player count 1");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    try {
      const client = new LmsClient({ host: "127.0.0.1", port: address.port, timeoutMs: 1000 });
      await expect(client.command("player count ?")).resolves.toBe("player count 1");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("detects command payloads that should never be shown as speaker metadata", () => {
    expect(
      isCommandPayload(
        "xstartprivateparty; set ui_mapname zm_cosmodrome; seta sv_maxclients 1; map zm_cosmodrome"
      )
    ).toBe(true);
    expect(isCommandPayload("Squeezebox Boom")).toBe(false);
  });

  it("sanitizes command payloads from player names", async () => {
    const payload = encodeURIComponent(
      "xstartprivateparty; set ui_mapname zm_cosmodrome; seta sv_maxclients 1; map zm_cosmodrome"
    );
    const client = new LmsClient();
    client.jsonRequest = async (params: unknown[]) => {
      const command = params[1] as unknown[];
      if (command[0] === "players") {
        return { result: { count: 1, players_loop: [{ playerid: "player-1", name: payload, connected: 1 }] } };
      }
      return { result: { player_name: payload, mode: "play", "mixer volume": 50, player_connected: 1 } };
    };

    const status = await client.status();

    expect(status.name).toBe("Squeezebox player");
  });

  it("reads player status through JSON-RPC without CLI fan-out", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };
    client.jsonRequest = async (params: unknown[]) => {
      const command = params[1] as unknown[];
      if (command[0] === "players") {
        return { result: { count: 1, players_loop: [{ playerid: "player-1", name: "Boom", connected: 1 }] } };
      }
      return { result: { player_name: "Boom", mode: "play", "mixer volume": 42, player_connected: 1 } };
    };

    const status = await client.status();

    expect(status).toMatchObject({ id: "player-1", name: "Boom", mode: "play", volume: 42, connected: true });
    expect(commands).toEqual([]);
  });

  it("returns stale Spotify status immediately while refreshing it", async () => {
    const client = new LmsClient();
    const stale = { configured: true, reachable: true, detail: "cached" };
    const fresh = { configured: true, reachable: false, detail: "fresh" };
    let releaseFresh!: () => void;
    let calls = 0;

    client.setCached("spotifyStatus", stale, -1);
    client.readSpotifyStatus = async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        releaseFresh = resolve;
      });
      return fresh;
    };

    await expect(client.spotifyStatus()).resolves.toEqual(stale);
    expect(calls).toBe(1);

    releaseFresh();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(client.spotifyStatus()).resolves.toEqual(fresh);
  });

  it("falls back to CLI status when JSON-RPC status fails", async () => {
    const client = new LmsClient();
    client.jsonRequest = async () => {
      throw new Error("JSON unavailable");
    };
    client.command = async (command: string) => {
      if (command === "player count ?") return "player count 1";
      if (command === "player id 0 ?") return "player id 0 player-1";
      if (command.endsWith("name ?")) return "player-1 name Boom";
      if (command.endsWith("mode ?")) return "player-1 mode play";
      if (command.endsWith("mixer volume ?")) return "player-1 mixer volume 50";
      return "ok";
    };

    await expect(client.status()).resolves.toMatchObject({ id: "player-1", name: "Boom", mode: "play", volume: 50 });
  });

  it("merges rich LMS status into now playing", async () => {
    const client = new LmsClient();
    client.command = async (command: string) => {
      if (command.endsWith("title ?")) return "p title Back%20%26%20Forth";
      if (command.endsWith("artist ?")) return "p artist Juice%20WRLD";
      if (command.endsWith("album ?")) return "p album 4%20Blessed%20Boys%20ERA";
      if (command.endsWith("duration ?")) return "p duration 231.4";
      if (command.endsWith("time ?")) return "p time 119";
      return "ok";
    };
    client.jsonRequest = async () => ({
      result: {
        can_seek: 1,
        playlist_loop: [{ coverid: "-104339503453992", title: "Back & Forth" }]
      }
    });

    const track = await client.nowPlaying("player-1");
    expect(track.title).toBe("Back & Forth");
    expect(track.artist).toBe("Juice WRLD");
    expect(track.canSeek).toBe(true);
    expect(track.art).toBe("api/artwork/-104339503453992");
  });

  it("normalizes Spotty now-playing ids into playable Spotify metadata", async () => {
    const client = new LmsClient();
    client.jsonRequest = async () => ({
      result: {
        time: 70,
        duration: 193.234,
        can_seek: 1,
        playlist_loop: [
          {
            id: "spotify://track:29TPjc8wxfz4XMn21O7VsZ",
            title: "Sky",
            artist: "Playboi Carti",
            album: "Whole Lotta Red",
            artwork_url: "https://i.scdn.co/image/test-cover"
          }
        ]
      }
    });

    const track = await client.nowPlaying("player-1");

    expect(track).toMatchObject({
      id: "spotify://track:29TPjc8wxfz4XMn21O7VsZ",
      title: "Sky",
      artist: "Playboi Carti",
      album: "Whole Lotta Red",
      source: "Spotify",
      uri: "spotify:track:29TPjc8wxfz4XMn21O7VsZ",
      kind: "track",
      canSeek: true,
      art: "api/image-proxy?url=https%3A%2F%2Fi.scdn.co%2Fimage%2Ftest-cover"
    });
  });

  it("builds Spotify recommendation candidates from artist radio and related artists", async () => {
    const client = new LmsClient();
    const browsed: string[] = [];
    const nav = (text: string, itemId: string) => ({ text, params: { item_id: itemId }, actions: { go: { params: { item_id: itemId } } } });
    const playable = (title: string, artist: string, uri: string, itemId: string, kind = "audio") => ({
      text: `${title}\n${artist} • Album`,
      params: { item_id: itemId },
      actions: { go: { params: { item_id: itemId } } },
      presetParams: {
        favorites_title: `${title} by ${artist} from Album`,
        favorites_type: kind,
        favorites_url: uri,
        icon: "https://i.scdn.co/image/test"
      }
    });
    client.jsonRequest = async (params: unknown[]) => {
      const command = params[1] as string[];
      const itemId = String(command.find((part) => String(part).startsWith("item_id:")) || "").replace(/^item_id:/, "");
      browsed.push(itemId);
      if (itemId === "1.0") return { result: { item_loop: [nav("Artists", "search-artists")] } };
      if (itemId === "search-artists") return { result: { item_loop: [playable("Seed Artist", "", "spotify:artist:seed", "artist-detail")] } };
      if (itemId === "artist-detail") return { result: { item_loop: [nav("Artist Radio", "artist-radio"), nav("Related Artists", "related-artists"), nav("Top Tracks", "top-tracks")] } };
      if (itemId === "artist-radio") return { result: { item_loop: [
        playable("Known Good", "Seed Artist", "spotify:track:known-good", "r1"),
        playable("Fresh Find", "Adjacent Artist", "spotify:track:fresh-find", "r2")
      ] } };
      if (itemId === "related-artists") return { result: { item_loop: [playable("Adjacent Artist", "", "spotify:artist:adjacent", "adjacent-detail")] } };
      if (itemId === "adjacent-detail") return { result: { item_loop: [nav("Top Tracks", "adjacent-top"), nav("Artist Radio", "adjacent-radio")] } };
      if (itemId === "adjacent-top") return { result: { item_loop: [playable("Related Hit", "Adjacent Artist", "spotify:track:related-hit", "rt1")] } };
      if (itemId === "adjacent-radio") return { result: { item_loop: [playable("Deep Cut", "Adjacent Artist", "spotify:track:deep-cut", "rr1")] } };
      return { result: { item_loop: [] } };
    };

    const candidates = await client.spotifyRecommendationCandidates("player-1", ["Seed Artist"], { limit: 6, relatedArtistsPerSeed: 1, relatedTracksPerArtist: 2 });

    expect(candidates.map((track) => track.uri)).toEqual([
      "spotify:track:known-good",
      "spotify:track:fresh-find",
      "spotify:track:related-hit",
      "spotify:track:deep-cut"
    ]);
    expect(candidates[0]).toMatchObject({ source: "Spotify", recommendationSource: "artist-radio" });
    expect(browsed).toContain("search-artists");
    expect(browsed).toContain("artist-radio");
    expect(browsed).toContain("related-artists");
  });

  it("normalizes Spotty ids when now-playing falls back to CLI metadata", async () => {
    const client = new LmsClient();
    client.command = async (command: string) => {
      if (command.endsWith("title ?")) return "p title Sky";
      if (command.endsWith("artist ?")) return "p artist Playboi%20Carti";
      if (command.endsWith("album ?")) return "p album Whole%20Lotta%20Red";
      if (command.endsWith("duration ?")) return "p duration 193.234";
      if (command.endsWith("time ?")) return "p time 70";
      return "ok";
    };
    client.jsonRequest = async () => ({
      result: {
        time: 70,
        duration: 193.234,
        can_seek: 1,
        playlist_loop: [
          {
            id: "spotify://track:29TPjc8wxfz4XMn21O7VsZ",
            title: "Sky"
          }
        ]
      }
    });

    const track = await client.nowPlaying("player-1");

    expect(track).toMatchObject({
      source: "Spotify",
      uri: "spotify:track:29TPjc8wxfz4XMn21O7VsZ",
      kind: "track",
      artist: "Playboi Carti"
    });
  });

  it("enriches local library rows with LMS cover ids", async () => {
    const client = new LmsClient();
    const requests: unknown[] = [];
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      return {
        result: {
          titles_loop: [
            {
              title: "Wrong Match",
              url: "file:///music/wrong/Art%20Track.mp3",
              coverid: "wrong-cover"
            },
            {
              title: "Art Track",
              url: "file:///music/test/Art%20Track.mp3",
              coverid: "cover-123"
            }
          ]
        }
      };
    };

    const rows = await client.enrichLocalArtwork([
      { title: "Art Track", path: "/music/test/Art Track.mp3", source: "Local library" },
      { title: "Spotify Track", uri: "spotify:track:abc", source: "Spotify" }
    ]);

    expect(rows[0]).toMatchObject({ title: "Art Track", art: "api/artwork/cover-123" });
    expect(rows[1]).not.toHaveProperty("art");
    expect(requests).toHaveLength(1);
  });

  it("returns partial local artwork when the enrichment deadline is reached", async () => {
    const client = new LmsClient();
    client.jsonRequest = async (params: unknown) => {
      const request = JSON.stringify(params);
      if (request.includes("Slow%20Art")) {
        // Far slower than the deadline so load jitter under the full parallel suite
        // can't flip the outcome (was 40ms vs a 15ms deadline — too tight, flaky).
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { result: { titles_loop: [{ url: "file:///music/test/Slow%20Art.mp3", coverid: "slow-cover" }] } };
      }
      return { result: { titles_loop: [{ url: "file:///music/test/Fast%20Art.mp3", coverid: "fast-cover" }] } };
    };

    const rows = await client.enrichLocalArtwork(
      [
        { title: "Fast Art", path: "/music/test/Fast Art.mp3", source: "Local library" },
        { title: "Slow Art", path: "/music/test/Slow Art.mp3", source: "Local library" }
      ],
      { limit: 2, concurrency: 1, deadlineMs: 80 }
    );

    expect(rows[0]).toMatchObject({ title: "Fast Art", art: "api/artwork/fast-cover" });
    expect(rows[1]).toMatchObject({ title: "Slow Art" });
    expect(rows[1]).not.toHaveProperty("art");
  });

  it("falls back to rich LMS status when CLI track fields contain command payloads", async () => {
    const payload = encodeURIComponent(
      "xstartprivateparty; set ui_mapname zm_cosmodrome; seta sv_maxclients 1; map zm_cosmodrome"
    );
    const client = new LmsClient();
    client.command = async (command: string) => {
      if (command.endsWith("title ?")) return `p title ${payload}`;
      if (command.endsWith("artist ?")) return `p artist ${payload}`;
      if (command.endsWith("album ?")) return `p album ${payload}`;
      if (command.endsWith("duration ?")) return "p duration 210";
      if (command.endsWith("time ?")) return "p time 20";
      return "ok";
    };
    client.jsonRequest = async () => ({
      result: {
        playlist_loop: [{ title: "Starfire", artist: "Eycer", album: "Single" }]
      }
    });

    const track = await client.nowPlaying("player-1");

    expect(track.title).toBe("Starfire");
    expect(track.artist).toBe("Eycer");
    expect(track.album).toBe("Single");
  });

  it("returns idle metadata when LMS is stopped with an empty playlist", async () => {
    const client = new LmsClient();
    client.command = async () => "p title stale";
    client.jsonRequest = async () => ({
      result: {
        mode: "stop",
        playlist_tracks: 0,
        playlist_loop: [{ title: "stale", artist: "stale" }]
      }
    });

    const track = await client.nowPlaying("player-1");

    expect(track).toMatchObject({
      id: "idle",
      title: "No track playing",
      artist: "Connect a player or request a song",
      canSeek: false,
      art: null
    });
  });

  it("does not use CLI fallback metadata for stopped players", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "p title stale";
    };
    client.jsonRequest = async () => ({
      result: {
        mode: "stopped",
        playlist_tracks: 1
      }
    });

    const track = await client.nowPlaying("player-1");

    expect(track.title).toBe("No track playing");
    expect(commands).toHaveLength(0);
  });

  it("maps app stream URLs back to uploaded track metadata", async () => {
    const previousUploadDir = config.uploadDir;
    config.uploadDir = "/music/uploads";
    const streamUrl = `http://192.168.1.142:4177/api/stream/${Buffer.from("/music/uploads/uploaded-song.mp3").toString("base64url")}/uploaded-song.mp3`;
    const client = new LmsClient();
    client.command = async (command: string) => {
      if (command.endsWith("title ?")) return `p title ${encodeURIComponent(streamUrl)}`;
      if (command.endsWith("artist ?")) return "p artist artist";
      if (command.endsWith("album ?")) return "p album album";
      if (command.endsWith("duration ?")) return "p duration 0";
      if (command.endsWith("time ?")) return "p time 0";
      return "ok";
    };
    client.jsonRequest = async () => ({ result: { playlist_loop: [{ url: streamUrl }] } });

    const track = await client.nowPlaying("player-1");

    expect(track.title).toBe("uploaded song");
    expect(track.source).toBe("Uploaded");
    config.uploadDir = previousUploadDir;
  });

  it("builds absolute seek commands", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };

    await client.control("00:04:20:1f:2c:56", "seek", 88);
    expect(commands[0]).toBe("00%3A04%3A20%3A1f%3A2c%3A56 time 88");
  });

  it("builds stop commands", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };

    await client.control("00:04:20:1f:2c:56", "stop");

    expect(commands[0]).toBe("00%3A04%3A20%3A1f%3A2c%3A56 stop");
  });

  it("detects authorized Spotty accounts from LMS config", async () => {
    const previousConfigDir = config.lmsConfigDir;
    config.lmsConfigDir = path.resolve("tests", "fixtures", "lms-config");
    const client = new LmsClient();

    const status = await client.detectSpottyFromConfig();

    expect(status.configured).toBe(true);
    expect(status.detail).toContain("authorized Spotify account");
    config.lmsConfigDir = previousConfigDir;
  });

  it("reports configured Spotty as unreachable when browsing returns only an empty no-action row", async () => {
    const previousConfigDir = config.lmsConfigDir;
    config.lmsConfigDir = path.resolve("tests", "fixtures", "lms-config");
    const client = new LmsClient();
    client.command = async (command: string) => {
      if (command === "player count ?") return "player count 1";
      if (command === "player id 0 ?") return "player id 0 player-1";
      return "ok";
    };
    client.jsonRequest = async () => ({
      result: {
        item_loop: [{ action: "none", type: "text", style: "itemNoAction", text: "Empty" }]
      }
    });

    const status = await client.spotifyStatus();

    expect(status.configured).toBe(true);
    expect(status.reachable).toBe(false);
    expect(status.detail).toContain("Reauthorize Spotty");
    config.lmsConfigDir = previousConfigDir;
  });

  it("reports configured Spotty as reachable when browse roots return playable containers", async () => {
    const previousConfigDir = config.lmsConfigDir;
    config.lmsConfigDir = path.resolve("tests", "fixtures", "lms-config");
    const client = new LmsClient();
    client.command = async (command: string) => {
      if (command === "player count ?") return "player count 1";
      if (command === "player id 0 ?") return "player id 0 player-1";
      return "ok";
    };
    client.jsonRequest = async () => ({
      result: {
        item_loop: [
          {
            text: "Starfire",
            type: "playlist",
            params: { item_id: "8.1" },
            presetParams: { favorites_url: "spotify:playlist:starfire", favorites_type: "playlist", favorites_title: "Starfire" }
          }
        ]
      }
    });

    const status = await client.spotifyStatus();

    expect(status.configured).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.detail).toContain("Spotify browsing is responding");
    config.lmsConfigDir = previousConfigDir;
  });

  it("caches Spotify status probes briefly", async () => {
    const previousConfigDir = config.lmsConfigDir;
    config.lmsConfigDir = path.resolve("tests", "fixtures", "lms-config");
    const client = new LmsClient();
    let commands = 0;
    let jsonRequests = 0;
    client.command = async (command: string) => {
      commands += 1;
      if (command === "player count ?") return "player count 1";
      if (command === "player id 0 ?") return "player id 0 player-1";
      return "ok";
    };
    client.jsonRequest = async () => {
      jsonRequests += 1;
      return {
        result: {
          item_loop: [{ action: "none", type: "text", style: "itemNoAction", text: "Empty" }]
        }
      };
    };

    const first = await client.spotifyStatus();
    const second = await client.spotifyStatus();

    expect(first).toEqual(second);
    expect(first.reachable).toBe(false);
    expect(commands).toBe(2);
    expect(jsonRequests).toBe(4);
    config.lmsConfigDir = previousConfigDir;
  });

  it("plays local tracks by resolved LMS track id", async () => {
    const requests: unknown[] = [];
    const client = new LmsClient();
    client.command = async () => "ok";
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      if (Array.isArray(params) && Array.isArray(params[1]) && params[1][0] === "songinfo") {
        return { result: { songinfo_loop: [{ id: 1519 }] } };
      }
      if (Array.isArray(params) && Array.isArray(params[1]) && params[1][0] === "titles") {
        return {
          result: {
            titles_loop: [
              {
                id: 1519,
                url: "file:///music/collections/2025%20JUICE%20WRLD%20Comp%20INACTIVE%207-6-25%20-%20@7eroz/Back%20in%20Chicago.mp3"
              }
            ]
          }
        };
      }
      return { result: {} };
    };

    await client.playTrack("player-1", { title: "Back in Chicago", path: "/music/collections/2025 JUICE WRLD Comp INACTIVE 7-6-25 - @7eroz/Back in Chicago.mp3" }, "play-now");

    expect(requests[0]).toEqual(["", ["songinfo", 0, 100, "url:file:///music/collections/2025%20JUICE%20WRLD%20Comp%20INACTIVE%207-6-25%20-%20%407eroz/Back%20in%20Chicago.mp3"]]);
    expect(requests.at(-1)).toEqual(["player-1", ["playlistcontrol", "cmd:load", "track_id:1519"]]);
  });

  it("plays uploaded tracks by indexed LMS track id when available", async () => {
    const requests: unknown[] = [];
    const client = new LmsClient();
    client.command = async () => "ok";
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      if (JSON.stringify(params).includes("titles")) {
        return {
          result: {
            titles_loop: [
              {
                id: 2424,
                url: "file:///music/uploads/upload.mp3"
              }
            ]
          }
        };
      }
      return { result: {} };
    };

    await client.playTrack("player-1", { title: "Upload", source: "Uploaded", uploaded: true, path: "/music/uploads/upload.mp3" }, "play-now");

    expect(requests.at(-1)).toEqual(["player-1", ["playlistcontrol", "cmd:load", "track_id:2424"]]);
  });

  it("falls back to the app stream URL before LMS has indexed the upload", async () => {
    const requests: unknown[] = [];
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      return { result: {} };
    };

    await client.playTrack("player-1", { title: "Upload", source: "Uploaded", uploaded: true, path: "/music/uploads/upload.mp3" }, "play-now");

    const encodedPath = Buffer.from("/music/uploads/upload.mp3").toString("base64url");
    expect(commands).toContain(`player-1 playlist play http://192.168.1.142:4177/api/stream/${encodedPath}/upload.mp3`);
  });

  it("does not resolve a local track to a fuzzy basename match", async () => {
    const requests: unknown[] = [];
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      if (JSON.stringify(params).includes("titles")) {
        return {
          result: {
            titles_loop: [
              {
                id: 999,
                url: "file:///music/wrong/remix-upload.mp3"
              }
            ]
          }
        };
      }
      return { result: {} };
    };

    await client.playTrack("player-1", { title: "Upload", source: "Uploaded", uploaded: true, path: "/music/uploads/upload.mp3" }, "play-now");

    const encodedPath = Buffer.from("/music/uploads/upload.mp3").toString("base64url");
    expect(requests).not.toContainEqual(["player-1", ["playlistcontrol", "cmd:load", "track_id:999"]]);
    expect(commands).toContain(`player-1 playlist play http://192.168.1.142:4177/api/stream/${encodedPath}/upload.mp3`);
  });

  it("does not resolve a local track to another file with the same basename", async () => {
    const requests: unknown[] = [];
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      if (JSON.stringify(params).includes("titles")) {
        return {
          result: {
            titles_loop: [
              {
                id: 999,
                url: "file:///music/wrong-folder/shared-name.mp3"
              }
            ]
          }
        };
      }
      return { result: {} };
    };

    await client.playTrack("player-1", { title: "Shared Name", path: "/music/right-folder/shared-name.mp3" }, "play-now");

    const encodedPath = Buffer.from("/music/right-folder/shared-name.mp3").toString("base64url");
    expect(requests).not.toContainEqual(["player-1", ["playlistcontrol", "cmd:load", "track_id:999"]]);
    expect(commands).toContain(`player-1 playlist play http://192.168.1.142:4177/api/stream/${encodedPath}/shared-name.mp3`);
  });

  it("inserts Spotify URI tracks as the next LMS item", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };

    await client.playTrack("player-1", { title: "Punisher", uri: "spotify:track:0123456789abcdefghijAB" }, "play-next");

    expect(commands.at(-1)).toBe("player-1 playlist insert spotify://track:0123456789abcdefghijAB");
  });

  it("loads Spotify tracks through LMS playlist commands for Spotty", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };

    await client.playTrack("player-1", { title: "Headlines", uri: "spotify:track:0123456789abcdefghijAB" }, "play-now");

    expect(commands).toContain("player-1 playlist play spotify://track:0123456789abcdefghijAB");
    expect(commands).toContain("player-1 play");
  });

  // --- Squeezebox Tap loop 1: album-load primitive (whole album from the top) ---
  it("loadAlbum loads a local album from the top via a native album-load command", async () => {
    const requests: unknown[] = [];
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      return { result: {} };
    };

    await client.loadAlbum("player-1", { source: "local", albumId: "42" });

    // Native LMS album load — NOT a manual per-track queue build.
    expect(requests).toContainEqual(["player-1", ["playlistcontrol", "cmd:load", "album_id:42"]]);
    expect(commands).toContain("player-1 play");
  });

  it("loadAlbum loads a Spotify album from the top through Spotty", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };

    await client.loadAlbum("player-1", { source: "spotify", albumUri: "spotify:album:xyz789" });

    expect(commands).toContain("player-1 playlist play spotify:album:xyz789");
    expect(commands).toContain("player-1 play");
  });

  // --- Squeezebox Tap loop 2: album-from-track (start the album AT a chosen track) ---
  it("loadAlbum starts a local album at the chosen track index (not from the top)", async () => {
    const requests: unknown[] = [];
    const client = new LmsClient();
    client.command = async () => "ok";
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      return { result: {} };
    };

    await client.loadAlbum("player-1", { source: "local", albumId: "42", startIndex: 3 });

    // Native atomic album load that STARTS at the chosen 0-based track via play_index
    // (LMS docs) — not a separate post-load jump that could race the playlist build.
    expect(requests).toContainEqual(["player-1", ["playlistcontrol", "cmd:load", "album_id:42", "play_index:3"]]);
  });

  it("loadAlbum starts a Spotify album at the chosen track index (not from the top)", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };

    await client.loadAlbum("player-1", { source: "spotify", albumUri: "spotify:album:xyz789", startIndex: 2 });

    expect(commands).toContain("player-1 playlist play spotify:album:xyz789");
    expect(commands).toContain("player-1 playlist index 2");
  });

  // --- Squeezebox Tap QoL: party-queue append, playlists, resume position ---
  it("loadAlbum APPENDS (not replaces) when queuing a Spotify album for party mode", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => { commands.push(command); return "ok"; };

    const result = await client.loadAlbum("player-1", { source: "spotify", albumUri: "spotify:album:xyz789", queue: true });

    expect(commands).toContain("player-1 playlist add spotify:album:xyz789");
    expect(commands).not.toContain("player-1 playlist play spotify:album:xyz789");
    expect(commands).not.toContain("player-1 play"); // appending never seizes playback
    expect(result).toMatchObject({ queued: true });
  });

  it("loadPlaylist plays a whole Spotify playlist via the colon form", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => { commands.push(command); return "ok"; };

    await client.loadPlaylist("player-1", { playlistUri: "spotify:playlist:abc123" });

    expect(commands).toContain("player-1 playlist play spotify:playlist:abc123");
    expect(commands).toContain("player-1 play");
  });

  it("loadPlaylist appends in queue mode and rejects a non-playlist URI", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => { commands.push(command); return "ok"; };

    await client.loadPlaylist("player-1", { playlistUri: "spotify:playlist:abc123", queue: true });
    expect(commands).toContain("player-1 playlist add spotify:playlist:abc123");

    await expect(client.loadPlaylist("player-1", { playlistUri: "spotify:album:xyz789" })).rejects.toThrow(/playlist/i);
  });

  it("playlistPosition reads the live track index and elapsed seconds", async () => {
    const client = new LmsClient();
    client.command = async (command: string) => {
      if (command.endsWith("playlist index ?")) return "player-1 playlist index 4";
      if (command.endsWith("time ?")) return "player-1 time 92.5";
      return "ok";
    };

    const pos = await client.playlistPosition("player-1");
    expect(pos).toEqual({ index: 4, seconds: 92 });
  });

  it("prefers a local file path over enrichment Spotify metadata for local tracks", async () => {
    const commands: string[] = [];
    const requests: unknown[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      return { result: {} };
    };

    await client.playTrack(
      "player-1",
      {
        title: "Bullet For My Valentine",
        artist: "Juice WRLD",
        source: "Local library",
        path: "/music/collections/Bullet For My Valentine.mp3",
        uri: "spotify:track:wrong"
      },
      "play-now"
    );

    expect(commands.some((command) => command.includes("spotify://track:wrong"))).toBe(false);
    expect(commands.some((command) => command.includes("/api/stream/"))).toBe(true);
  });

  it("maps Spotty search results to playable Spotify tracks", async () => {
    const client = new LmsClient();
    client.jsonRequest = async () => ({
      result: {
        item_loop: [
          { text: "Artists", goAction: "go" },
          {
            text: "Headlines\nDrake • Take Care (Deluxe)",
            goAction: "playControl",
            presetParams: { favorites_url: "spotify:track:abc123", icon: "https://i.scdn.co/image/test" }
          }
        ]
      }
    });

    const results = await client.spotifySearch("player-1", "drake");

    expect(results[0]).toMatchObject({
      title: "Headlines",
      artist: "Drake",
      album: "Take Care (Deluxe)",
      uri: "spotify:track:abc123",
      source: "Spotify",
      art: "api/image-proxy?url=https%3A%2F%2Fi.scdn.co%2Fimage%2Ftest"
    });
  });

  it("includes Spotify artists albums and playlists in search results", async () => {
    const requests: unknown[] = [];
    const client = new LmsClient();
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      const args = Array.isArray(params) && Array.isArray(params[1]) ? params[1] : [];
      const itemArg = args.find((item) => typeof item === "string" && item.startsWith("item_id:"));
      if (itemArg === "item_id:1.0_drake.0") {
        return {
          result: {
            title: "Artists",
            item_loop: [
              {
                text: "Drake\nFollowers: 111",
                presetParams: { favorites_url: "spotify:artist:artist1", favorites_title: "Drake", icon: "artist.png" }
              }
            ]
          }
        };
      }
      if (itemArg === "item_id:1.0_drake.1") {
        return {
          result: {
            title: "Albums",
            item_loop: [
              {
                text: "Take Care\nDrake",
                presetParams: { favorites_url: "spotify:album:album1", favorites_title: "Take Care by Drake", icon: "album.png" }
              }
            ]
          }
        };
      }
      if (itemArg === "item_id:1.0_drake.2") {
        return {
          result: {
            title: "Playlists",
            item_loop: [
              {
                text: "Drake Mix\nby spotify",
                presetParams: { favorites_url: "spotify:playlist:playlist1", favorites_title: "Drake Mix", icon: "playlist.png" }
              }
            ]
          }
        };
      }
      return {
        result: {
          item_loop: [
            { text: "Artists", actions: { go: { params: { item_id: "1.0_drake.0" } } } },
            { text: "Albums", actions: { go: { params: { item_id: "1.0_drake.1" } } } },
            { text: "Playlists", actions: { go: { params: { item_id: "1.0_drake.2" } } } },
            {
              text: "Headlines\nDrake • Take Care",
              goAction: "playControl",
              presetParams: { favorites_url: "spotify:track:track1", favorites_title: "Headlines by Drake from Take Care" }
            }
          ]
        }
      };
    };

    const results = await client.spotifySearch("player-1", "drake", 10);

    expect(requests).toContainEqual(["player-1", ["spotty", "items", 0, 20, "menu:spotty", "item_id:1.0", "search:drake", "cachesearch:1"]]);
    expect(results.map((result) => result.kind)).toEqual(expect.arrayContaining(["track", "artist", "album", "playlist"]));
    expect(results.find((result) => result.kind === "album")).toMatchObject({ title: "Take Care", artist: "Drake" });
  });

  it("widens small Spotify searches so the returned page can include playable tracks", async () => {
    const requests: unknown[] = [];
    const client = new LmsClient();
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      return {
        result: {
          item_loop: [
            { text: "Artists", actions: { go: { params: { item_id: "1.0_drake.0" } } } },
            { text: "Albums", actions: { go: { params: { item_id: "1.0_drake.1" } } } },
            { text: "Playlists", actions: { go: { params: { item_id: "1.0_drake.2" } } } },
            {
              text: "Headlines\nDrake â€¢ Take Care",
              goAction: "playControl",
              presetParams: { favorites_url: "spotify:track:track1", favorites_title: "Headlines by Drake from Take Care" }
            },
            {
              text: "Passionfruit\nDrake â€¢ More Life",
              goAction: "playControl",
              presetParams: { favorites_url: "spotify:track:track2", favorites_title: "Passionfruit by Drake from More Life" }
            }
          ]
        }
      };
    };

    const results = await client.spotifySearch("player-1", "drake", 5);

    expect(requests[0]).toEqual(["player-1", ["spotty", "items", 0, 20, "menu:spotty", "item_id:1.0", "search:drake", "cachesearch:1"]]);
    expect(results.map((result) => result.kind)).toEqual(["track", "track"]);
  });

  it("does not block playable Spotify search results on slow category expansion", async () => {
    const requests: unknown[] = [];
    const client = new LmsClient();
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      const args = Array.isArray(params) && Array.isArray(params[1]) ? params[1] : [];
      const itemArg = args.find((item) => typeof item === "string" && item.startsWith("item_id:"));
      if (itemArg === "item_id:1.0_drake.0") {
        return new Promise(() => {});
      }
      return {
        result: {
          item_loop: [
            { text: "Artists", actions: { go: { params: { item_id: "1.0_drake.0" } } } },
            ...Array.from({ length: 5 }, (_, index) => ({
              text: `Track ${index}\nArtist - Album`,
              goAction: "playControl",
              presetParams: { favorites_url: `spotify:track:track${index}`, favorites_title: `Track ${index} by Artist from Album` }
            }))
          ]
        }
      };
    };

    const started = Date.now();
    const results = await client.spotifySearch("player-1", "drake", 5);

    expect(Date.now() - started).toBeLessThan(1200);
    expect(results).toHaveLength(5);
    expect(results.map((result) => result.kind)).toEqual(["track", "track", "track", "track", "track"]);
    expect(requests).toHaveLength(2);
  });

  it("does not wait for slow category expansion when Spotify search has playable tracks", async () => {
    const requests: unknown[] = [];
    const client = new LmsClient();
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      const args = Array.isArray(params) && Array.isArray(params[1]) ? params[1] : [];
      const itemArg = args.find((item) => typeof item === "string" && item.startsWith("item_id:"));
      if (itemArg === "item_id:1.0_drake.0") {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return {
          result: {
            title: "Artists",
            item_loop: [
              { text: "Drake", presetParams: { favorites_url: "spotify:artist:drake", favorites_title: "Drake" } }
            ]
          }
        };
      }
      return {
        result: {
          item_loop: [
            { text: "Artists", actions: { go: { params: { item_id: "1.0_drake.0" } } } },
            {
              text: "Headlines\nDrake - Take Care",
              goAction: "playControl",
              presetParams: { favorites_url: "spotify:track:track1", favorites_title: "Headlines by Drake from Take Care" }
            }
          ]
        }
      };
    };

    const started = Date.now();
    const results = await client.spotifySearch("player-1", "drake", 10);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(results).toEqual([expect.objectContaining({ title: "Headlines", kind: "track" })]);
    expect(requests).toHaveLength(2);
  });

  it("reuses widened Spotify search cache for nearby small limits", async () => {
    let requests = 0;
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      return {
        result: {
          item_loop: Array.from({ length: 8 }, (_, index) => ({
            text: `Track ${index}\nArtist â€¢ Album`,
            goAction: "playControl",
            presetParams: { favorites_url: `spotify:track:track${index}`, favorites_title: `Track ${index} by Artist from Album` }
          }))
        }
      };
    };

    const first = await client.spotifySearch("player-1", "drake", 5);
    const second = await client.spotifySearch("player-1", "drake", 8);

    expect(first).toHaveLength(5);
    expect(second).toHaveLength(8);
    expect(requests).toBe(1);
  });

  it("serves narrower Spotify searches from a cached full suggestion page", async () => {
    let requests = 0;
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      return {
        result: {
          item_loop: Array.from({ length: 50 }, (_, index) => ({
            text: `Track ${index}\nArtist - Album`,
            goAction: "playControl",
            presetParams: { favorites_url: `spotify:track:wide${index}`, favorites_title: `Track ${index} by Artist from Album` }
          }))
        }
      };
    };

    const full = await client.spotifySearch("player-1", "drake", 50);
    const narrow = await client.spotifySearch("player-1", "drake", 20);

    expect(full).toHaveLength(50);
    expect(narrow).toHaveLength(20);
    expect(narrow.map((track) => track.uri)).toEqual(full.slice(0, 20).map((track) => track.uri));
    expect(requests).toBe(1);
  });

  it("serves stale Spotify search cache while refreshing in the background", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = new LmsClient();
    client.setCached(
      "spotifySearch:player-1:drake:20",
      [{ title: "Stale Track", artist: "Drake", uri: "spotify:track:stale", kind: "track" }],
      -1
    );
    client.jsonRequest = async () => {
      await gate;
      return {
        result: {
          item_loop: [
            {
              text: "Fresh Track\nDrake - Album",
              goAction: "playControl",
              presetParams: { favorites_url: "spotify:track:fresh", favorites_title: "Fresh Track by Drake from Album" }
            }
          ]
        }
      };
    };

    const started = Date.now();
    const stale = await client.spotifySearch("player-1", "drake", 20);

    expect(Date.now() - started).toBeLessThan(200);
    expect(stale).toEqual([expect.objectContaining({ title: "Stale Track" })]);

    release(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fresh = await client.spotifySearch("player-1", "drake", 20);

    expect(fresh).toEqual([expect.objectContaining({ title: "Fresh Track" })]);
  });

  it("serves narrower Spotify searches from an in-flight full suggestion page", async () => {
    let requests = 0;
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      await gate;
      return {
        result: {
          item_loop: Array.from({ length: 50 }, (_, index) => ({
            text: `Track ${index}\nArtist - Album`,
            goAction: "playControl",
            presetParams: { favorites_url: `spotify:track:inflight${index}`, favorites_title: `Track ${index} by Artist from Album` }
          }))
        }
      };
    };

    const full = client.spotifySearch("player-1", "drake", 50);
    const narrow = client.spotifySearch("player-1", "drake", 20);
    release(null);
    const [fullResult, narrowResult] = await Promise.all([full, narrow]);

    expect(fullResult).toHaveLength(50);
    expect(narrowResult).toHaveLength(20);
    expect(narrowResult.map((track) => track.uri)).toEqual(fullResult.slice(0, 20).map((track) => track.uri));
    expect(requests).toBe(1);
  });

  it("normalizes Spotify search whitespace before request and cache lookup", async () => {
    const searches: string[] = [];
    const client = new LmsClient();
    client.jsonRequest = async (params: unknown) => {
      const command = (params as [string, string[]])[1];
      const search = command.find((item) => String(item).startsWith("search:"));
      searches.push(String(search || ""));
      return {
        result: {
          item_loop: Array.from({ length: 20 }, (_, index) => ({
            text: `Weeknd Track ${index}\nArtist - Album`,
            goAction: "playControl",
            presetParams: { favorites_url: `spotify:track:weeknd${index}`, favorites_title: `Weeknd Track ${index} by Artist from Album` }
          }))
        }
      };
    };

    const first = await client.spotifySearch("player-1", "the   weeknd", 10);
    const second = await client.spotifySearch("player-1", "The Weeknd", 10);

    expect(first.map((track) => track.uri)).toEqual(second.map((track) => track.uri));
    expect(searches).toEqual(["search:the weeknd"]);
  });

  it("drops loose Spotty fuzzy matches for long single-token noise searches", async () => {
    let requests = 0;
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      return {
        result: {
          item_loop: [
            {
              text: "abcdefu\nGAYLE - single",
              goAction: "playControl",
              presetParams: { favorites_url: "spotify:track:abcdefu", favorites_title: "abcdefu by GAYLE from single" }
            },
            {
              text: "The Duck Song\nThe Duck - single",
              goAction: "playControl",
              presetParams: { favorites_url: "spotify:track:duck", favorites_title: "The Duck Song by The Duck from single" }
            }
          ]
        }
      };
    };

    const first = await client.spotifySearch("player-1", "asdfghjk", 10);
    const second = await client.spotifySearch("player-1", "asdfghjk", 10);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(requests).toBe(1);
  });

  it("short-circuits obvious random single-token Spotify searches before Spotty", async () => {
    let requests = 0;
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      return {
        result: {
          item_loop: [
            {
              text: "The Duck Song\nThe Duck - single",
              goAction: "playControl",
              presetParams: { favorites_url: "spotify:track:duck", favorites_title: "The Duck Song by The Duck from single" }
            }
          ]
        }
      };
    };

    const first = await client.spotifySearch("player-1", "zzxqwrtyps", 10);
    const second = await client.spotifySearch("player-1", "zzxqwrtyps", 10);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(requests).toBe(0);
  });

  it("keeps compact single-token Spotify searches when title artist or album actually matches", async () => {
    const client = new LmsClient();
    client.jsonRequest = async () => ({
      result: {
        item_loop: [
          {
            text: "Lucid Dreams\nJuice WRLD - Goodbye & Good Riddance",
            goAction: "playControl",
            presetParams: { favorites_url: "spotify:track:lucid", favorites_title: "Lucid Dreams by Juice WRLD from Goodbye & Good Riddance" }
          },
          {
            text: "Unrelated\nOther Artist - single",
            goAction: "playControl",
            presetParams: { favorites_url: "spotify:track:other", favorites_title: "Unrelated by Other Artist from single" }
          }
        ]
      }
    });

    const results = await client.spotifySearch("player-1", "juicewrld", 10);

    expect(results).toEqual([expect.objectContaining({ title: "Lucid Dreams", artist: "Juice WRLD" })]);
  });

  it("serves concurrent Spotify searches from one in-flight request", async () => {
    let requests = 0;
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      await gate;
      return {
        result: {
          item_loop: Array.from({ length: 20 }, (_, index) => ({
            text: `Track ${index}\nArtist - Album`,
            goAction: "playControl",
            presetParams: { favorites_url: `spotify:track:track${index}`, favorites_title: `Track ${index} by Artist from Album` }
          }))
        }
      };
    };

    const narrow = client.spotifySearch("player-1", "drake", 5);
    const wide = client.spotifySearch("player-1", "drake", 20);
    release(null);
    const [narrowResult, wideResult] = await Promise.all([narrow, wide]);

    expect(narrowResult).toHaveLength(5);
    expect(wideResult).toHaveLength(20);
    expect(requests).toBe(1);
  });

  it("does not cache empty Spotify search pages", async () => {
    let requests = 0;
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      if (requests === 1) return { result: { item_loop: [] } };
      return {
        result: {
          item_loop: [
            {
              text: "Headlines\nDrake â€¢ Take Care",
              goAction: "playControl",
              presetParams: { favorites_url: "spotify:track:track1", favorites_title: "Headlines by Drake from Take Care" }
            }
          ]
        }
      };
    };

    const empty = await client.spotifySearch("player-1", "drake", 50);
    const recovered = await client.spotifySearch("player-1", "drake", 50);

    expect(empty).toEqual([]);
    expect(recovered).toEqual([expect.objectContaining({ title: "Headlines", uri: "spotify:track:track1" })]);
    expect(requests).toBe(2);
  });

  it("serves smaller Spotify library requests through a wider cached page", async () => {
    let requests = 0;
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      return {
        result: {
          item_loop: Array.from({ length: 80 }, (_, index) => ({
            text: `Playlist ${index + 1}\nby Spotify`,
            presetParams: { favorites_url: `spotify:playlist:${index + 1}`, favorites_title: `Playlist ${index + 1}` }
          }))
        }
      };
    };

    const firstNarrow = await client.spotifyLibrary("player-1", "playlists", 8, 0);
    const wide = await client.spotifyLibrary("player-1", "playlists", 80, 0);
    const secondNarrow = await client.spotifyLibrary("player-1", "playlists", 8, 0);

    expect(firstNarrow).toHaveLength(8);
    expect(wide).toHaveLength(80);
    expect(secondNarrow).toHaveLength(8);
    expect(requests).toBe(1);
  });

  it("does not live-probe Spotify saved albums because Spotty imports can be heavy", async () => {
    const requests: unknown[] = [];
    const client = new LmsClient();
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      return {
        result: {
          item_loop: [{ text: "Album One\nby Spotify", presetParams: { favorites_url: "spotify:album:one", favorites_title: "Album One" } }]
        }
      };
    };

    const results = await client.spotifyLibrary("player-1", "albums", 5, 0);

    expect(results).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("deduplicates concurrent Spotify library browse requests", async () => {
    let requests = 0;
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      await gate;
      return {
        result: {
          item_loop: [{ text: "Playlist One\nby Spotify", presetParams: { favorites_url: "spotify:playlist:one", favorites_title: "Playlist One" } }]
        }
      };
    };

    const first = client.spotifyLibrary("player-1", "playlists", 8, 0);
    const second = client.spotifyLibrary("player-1", "playlists", 8, 0);
    release(null);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toHaveLength(1);
    expect(secondResult).toHaveLength(1);
    expect(requests).toBe(1);
  });

  it("serves narrow Spotify playlist requests from an in-flight wider browse", async () => {
    let requests = 0;
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      await gate;
      return {
        result: {
          item_loop: Array.from({ length: 80 }, (_, index) => ({
            text: `Playlist ${index + 1}\nby Spotify`,
            presetParams: { favorites_url: `spotify:playlist:${index + 1}`, favorites_title: `Playlist ${index + 1}` }
          }))
        }
      };
    };

    const wide = client.spotifyLibrary("player-1", "playlists", 80, 0);
    const narrow = client.spotifyLibrary("player-1", "playlists", 5, 0);
    release(null);
    const [wideResult, narrowResult] = await Promise.all([wide, narrow]);

    expect(wideResult).toHaveLength(80);
    expect(narrowResult).toHaveLength(5);
    expect(requests).toBe(1);
  });

  it("serves offset Spotify library requests from a cached wider first page", async () => {
    let requests = 0;
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      return {
        result: {
          item_loop: Array.from({ length: 80 }, (_, index) => ({
            text: `Playlist ${index + 1}\nby Spotify`,
            presetParams: { favorites_url: `spotify:playlist:${index + 1}`, favorites_title: `Playlist ${index + 1}` }
          }))
        }
      };
    };

    const firstPage = await client.spotifyLibrary("player-1", "playlists", 80, 0);
    const offsetPage = await client.spotifyLibrary("player-1", "playlists", 5, 10);

    expect(firstPage).toHaveLength(80);
    expect(offsetPage.map((item) => item.title)).toEqual(["Playlist 11", "Playlist 12", "Playlist 13", "Playlist 14", "Playlist 15"]);
    expect(requests).toBe(1);
  });

  it("returns empty uncached Spotify saved albums without retrying Spotty", async () => {
    let requests = 0;
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      return requests === 1
        ? { result: { item_loop: [] } }
        : { result: { item_loop: [{ text: "Album One\nby Spotify", presetParams: { favorites_url: "spotify:album:one", favorites_title: "Album One" } }] } };
    };

    const empty = await client.spotifyLibrary("player-1", "albums", 5, 0);
    const filled = await client.spotifyLibrary("player-1", "albums", 5, 0);

    expect(empty).toEqual([]);
    expect(filled).toEqual([]);
    expect(requests).toBe(0);
  });

  it("serves stale Spotify library cache when a browse refresh is slow", async () => {
    const client = new LmsClient();
    const cacheKey = "spotifyLibrary:player-1:albums:8:0";
    client.cache.set(cacheKey, {
      value: [{ id: "spotify:album:stale", title: "Stale Album", artist: "Spotify", uri: "spotify:album:stale", kind: "album" }],
      expiresAt: Date.now() - 1000
    });
    client.jsonRequest = async () => new Promise(() => {});

    const started = Date.now();
    const results = await client.spotifyLibrary("player-1", "albums", 8, 0);

    expect(Date.now() - started).toBeLessThan(2500);
    expect(results).toEqual([expect.objectContaining({ title: "Stale Album" })]);
  });

  it("returns only playable tracks from Spotify children", async () => {
    const client = new LmsClient();
    client.jsonRequest = async () => ({
      result: {
        item_loop: [
          { text: "Daily Mix\nby Spotify", presetParams: { favorites_url: "spotify:playlist:daily", favorites_title: "Daily Mix" } },
          { text: "Track One\nArtist - Album", presetParams: { favorites_url: "spotify:track:one", favorites_title: "Track One" } },
          { text: "Album One\nby Artist", presetParams: { favorites_url: "spotify:album:one", favorites_title: "Album One" } }
        ]
      }
    });

    const results = await client.spotifyChildren("player-1", { uri: "spotify:playlist:test", kind: "playlist" }, 10, 0);

    expect(results).toEqual([expect.objectContaining({ title: "Track One", uri: "spotify:track:one", kind: "track" })]);
  });

  it("does not synthesize a Spotify track from non-track child URIs", async () => {
    const client = new LmsClient();
    client.jsonRequest = async () => ({ result: { item_loop: [] } });

    const playlist = await client.spotifyChildren("player-1", { uri: "spotify:playlist:test", kind: "track" }, 10, 0);
    const malformedTrack = await client.spotifyChildren("player-1", { uri: "spotify:track:not-valid", kind: "track" }, 10, 0);

    expect(playlist).toEqual([]);
    expect(malformedTrack).toEqual([]);
  });

  it("falls back to Spotify search when artist children are empty", async () => {
    const requests: unknown[] = [];
    const client = new LmsClient();
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      const args = Array.isArray(params) && Array.isArray(params[1]) ? params[1] : [];
      if (args.some((item) => item === "search:Ado")) {
        return {
          result: {
            item_loop: [
              {
                text: "Artist Song\nAdo - Album",
                presetParams: { favorites_url: "spotify:track:artist-song", favorites_title: "Artist Song by Ado from Album" }
              },
              {
                text: "Other Song\nDifferent Artist - Album",
                presetParams: { favorites_url: "spotify:track:other-song", favorites_title: "Other Song by Different Artist from Album" }
              }
            ]
          }
        };
      }
      return { result: { item_loop: [] } };
    };

    const results = await client.spotifyChildren(
      "player-1",
      { browseId: "7.0", uri: "spotify:artist:artist", kind: "artist", title: "Ado" },
      10,
      0
    );

    expect(results).toEqual([expect.objectContaining({ title: "Artist Song", artist: "Ado", kind: "track" })]);
    expect(requests).toEqual([
      ["player-1", ["spotty", "items", 0, 20, "menu:spotty", "item_id:1.0", "search:Ado", "cachesearch:1"]]
    ]);
  });

  it("waits for cold artist search fallback instead of returning a false empty page", async () => {
    const client = new LmsClient();
    client.spotifySearch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 2300));
      return [{ title: "Slow Artist Song", artist: "Ado", uri: "spotify:track:slow-artist-song", kind: "track" }];
    };

    const results = await client.spotifyChildren("player-1", { browseId: "7.0", kind: "artist", title: "Ado" }, 10, 0);

    expect(results).toEqual([expect.objectContaining({ title: "Slow Artist Song", artist: "Ado", kind: "track" })]);
  });

  it("serves smaller Spotify children requests through a wider cached page", async () => {
    const requests: unknown[] = [];
    const client = new LmsClient();
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      return {
        result: {
          item_loop: Array.from({ length: 200 }, (_, index) => ({
            text: `Track ${index + 1}\nArtist ${index + 1} - Album`,
            presetParams: { favorites_url: `spotify:track:${index + 1}`, favorites_title: `Track ${index + 1}` }
          }))
        }
      };
    };

    const firstNarrow = await client.spotifyChildren("player-1", { uri: "spotify:playlist:test", kind: "playlist" }, 10, 0);
    const wide = await client.spotifyChildren("player-1", { uri: "spotify:playlist:test", kind: "playlist" }, 200, 0);
    const secondNarrow = await client.spotifyChildren("player-1", { uri: "spotify:playlist:test", kind: "playlist" }, 5, 0);
    const offsetWindow = await client.spotifyChildren("player-1", { uri: "spotify:playlist:test", kind: "playlist" }, 5, 10);

    expect(firstNarrow).toHaveLength(10);
    expect(wide).toHaveLength(200);
    expect(secondNarrow).toHaveLength(5);
    expect(offsetWindow.map((item) => item.title)).toEqual(["Track 11", "Track 12", "Track 13", "Track 14", "Track 15"]);
    expect(requests).toEqual([
      ["player-1", ["spotty", "items", 0, 200, "menu:spotty", "item_id:spotify:playlist:test"]]
    ]);
  });

  it("waits for cold Spotify playlist children instead of returning a false empty page", async () => {
    const client = new LmsClient();
    client.jsonRequest = async () => {
      await new Promise((resolve) => setTimeout(resolve, 2300));
      return {
        result: {
          item_loop: [{
            text: "Slow Playlist Track\nTester - Album",
            presetParams: { favorites_url: "spotify:track:slow-playlist-track", favorites_title: "Slow Playlist Track" }
          }]
        }
      };
    };

    const started = Date.now();
    const results = await client.spotifyChildren("player-1", { uri: "spotify:playlist:slow", kind: "playlist" }, 10, 0);

    expect(Date.now() - started).toBeGreaterThanOrEqual(2200);
    expect(results).toEqual([expect.objectContaining({ title: "Slow Playlist Track", uri: "spotify:track:slow-playlist-track" })]);
  });

  it("uses cached Spotify container browse ids when children are requested by URI only", async () => {
    const requests: unknown[] = [];
    const client = new LmsClient();
    client.jsonRequest = async (params: unknown) => {
      requests.push(params);
      const args = (params as unknown[])[1] as string[];
      const itemId = args.find((value) => String(value).startsWith("item_id:"));
      if (itemId === "item_id:8") {
        return {
          result: {
            item_loop: [{
              text: "Cached Playlist\nby Spotify",
              actions: { go: { params: { item_id: "8.4" } } },
              presetParams: { favorites_url: "spotify:playlist:cached", favorites_title: "Cached Playlist", favorites_type: "playlist" }
            }]
          }
        };
      }
      if (itemId === "item_id:8.4") {
        return {
          result: {
            item_loop: [{
              text: "Cached Child\nTester - Album",
              presetParams: { favorites_url: "spotify:track:cachedchild", favorites_title: "Cached Child" }
            }]
          }
        };
      }
      return { result: { item_loop: [] } };
    };

    const playlists = await client.spotifyLibrary("player-1", "playlists", 1, 0);
    const children = await client.spotifyChildren("player-1", { uri: playlists[0].uri, kind: "playlist", title: playlists[0].title }, 5, 0);

    expect(children).toEqual([expect.objectContaining({ title: "Cached Child", uri: "spotify:track:cachedchild" })]);
    expect(requests).toEqual([
      ["player-1", ["spotty", "items", 0, 80, "menu:spotty", "item_id:8"]],
      ["player-1", ["spotty", "items", 0, 200, "menu:spotty", "item_id:8.4"]]
    ]);
  });

  it("serves narrow Spotify children requests from an in-flight wider browse", async () => {
    let requests = 0;
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      await gate;
      return {
        result: {
          item_loop: Array.from({ length: 200 }, (_, index) => ({
            text: `Track ${index + 1}\nArtist ${index + 1} - Album`,
            presetParams: { favorites_url: `spotify:track:${index + 1}`, favorites_title: `Track ${index + 1}` }
          }))
        }
      };
    };

    const wide = client.spotifyChildren("player-1", { uri: "spotify:playlist:test", kind: "playlist" }, 200, 0);
    const narrow = client.spotifyChildren("player-1", { uri: "spotify:playlist:test", kind: "playlist" }, 8, 0);
    release(null);
    const [wideResult, narrowResult] = await Promise.all([wide, narrow]);

    expect(wideResult).toHaveLength(200);
    expect(narrowResult).toHaveLength(8);
    expect(requests).toBe(1);
  });

  it("briefly caches empty Spotify children pages", async () => {
    let requests = 0;
    const client = new LmsClient();
    client.jsonRequest = async () => {
      requests += 1;
      return { result: { item_loop: [{ text: "Nested Playlist", presetParams: { favorites_url: "spotify:playlist:nested", favorites_title: "Nested Playlist" } }] } };
    };

    const first = await client.spotifyChildren("player-1", { uri: "spotify:playlist:empty", kind: "playlist" }, 10, 0);
    const second = await client.spotifyChildren("player-1", { uri: "spotify:playlist:empty", kind: "playlist" }, 10, 0);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(requests).toBe(2);
  });
});
