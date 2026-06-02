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
    client.command = async (command: string) => {
      if (command === "player count ?") return "player count 1";
      if (command === "player id 0 ?") return "player id 0 player-1";
      if (command.endsWith("name ?")) return `player-1 name ${payload}`;
      if (command.endsWith("mode ?")) return "player-1 mode play";
      if (command.endsWith("mixer volume ?")) return "player-1 mixer volume 50";
      return "ok";
    };

    const status = await client.status();

    expect(status.name).toBe("Squeezebox player");
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

  it("detects authorized Spotty accounts from LMS config", async () => {
    const previousConfigDir = config.lmsConfigDir;
    config.lmsConfigDir = path.resolve("tests", "fixtures", "lms-config");
    const client = new LmsClient();

    const status = await client.detectSpottyFromConfig();

    expect(status.configured).toBe(true);
    expect(status.detail).toContain("authorized Spotify account");
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

  it("inserts Spotify URI tracks as the next LMS item", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };

    await client.playTrack("player-1", { title: "Punisher", uri: "spotify:track:abc123" }, "play-next");

    expect(commands.at(-1)).toBe("player-1 playlist insert spotify://track:abc123");
  });

  it("loads Spotify tracks through LMS playlist commands for Spotty", async () => {
    const commands: string[] = [];
    const client = new LmsClient();
    client.command = async (command: string) => {
      commands.push(command);
      return "ok";
    };

    await client.playTrack("player-1", { title: "Headlines", uri: "spotify:track:abc123" }, "play-now");

    expect(commands).toContain("player-1 playlist play spotify://track:abc123");
    expect(commands).toContain("player-1 play");
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
      source: "Spotify"
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

    expect(requests).toContainEqual(["player-1", ["spotty", "items", 0, 10, "menu:spotty", "item_id:1.0", "search:drake", "cachesearch:1"]]);
    expect(results.map((result) => result.kind)).toEqual(expect.arrayContaining(["track", "artist", "album", "playlist"]));
    expect(results.find((result) => result.kind === "album")).toMatchObject({ title: "Take Care", artist: "Drake" });
  });

  it("serves smaller Spotify library requests from a wider cached page", async () => {
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

    const wide = await client.spotifyLibrary("player-1", "playlists", 80, 0);
    const narrow = await client.spotifyLibrary("player-1", "playlists", 8, 0);

    expect(wide).toHaveLength(80);
    expect(narrow).toHaveLength(8);
    expect(requests).toBe(1);
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

  it("serves narrow Spotify library requests from an in-flight wider browse", async () => {
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
            text: `Album ${index + 1}\nby Spotify`,
            presetParams: { favorites_url: `spotify:album:${index + 1}`, favorites_title: `Album ${index + 1}` }
          }))
        }
      };
    };

    const wide = client.spotifyLibrary("player-1", "albums", 80, 0);
    const narrow = client.spotifyLibrary("player-1", "albums", 5, 0);
    release(null);
    const [wideResult, narrowResult] = await Promise.all([wide, narrow]);

    expect(wideResult).toHaveLength(80);
    expect(narrowResult).toHaveLength(5);
    expect(requests).toBe(1);
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
});
