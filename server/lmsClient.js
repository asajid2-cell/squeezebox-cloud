import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./state.js";
import { fileToTrack } from "./library.js";

const spotifySearchCacheMs = 2 * 60 * 1000;
const spotifyBrowseCacheMs = 5 * 60 * 1000;
const spotifyBrowseDeadlineMs = Number(process.env.SPOTIFY_BROWSE_DEADLINE_MS || 1800);
const spotifyColdBrowseDeadlineMs = Number(process.env.SPOTIFY_COLD_BROWSE_DEADLINE_MS || 3200);

export class LmsClient {
  constructor(options = {}) {
    this.host = options.host || config.lmsHost;
    this.port = options.port || config.lmsCliPort;
    this.timeoutMs = options.timeoutMs || 3500;
    this.cache = new Map();
    this.inflight = new Map();
  }

  command(command) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let data = "";
      let settled = false;
      let idleTimer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(idleTimer);
        socket.end();
        resolve(String(value || "").trim());
      };
      const timer = setTimeout(() => {
        if (data) {
          finish(data);
          return;
        }
        settled = true;
        socket.destroy();
        reject(new Error(`LMS CLI timeout for command: ${command}`));
      }, this.timeoutMs);

      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${command}\n`));
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\n")) {
          finish(data);
          return;
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(data), 80);
      });
      socket.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(idleTimer);
        reject(error);
      });
      socket.on("close", () => {
        if (data) finish(data);
        clearTimeout(timer);
        clearTimeout(idleTimer);
      });
    });
  }

  async status() {
    const countResponse = await this.command("player count ?");
    const count = Number(lastToken(countResponse));
    if (!Number.isFinite(count) || count < 1) {
      return { connected: false, online: true, detail: "LMS online, no player connected" };
    }

    const playerIdResponse = await this.command("player id 0 ?");
    const playerId = decodeURIComponent(lastToken(playerIdResponse));
    const nameResponse = await this.command(`${encodeURIComponent(playerId)} name ?`);
    const modeResponse = await this.command(`${encodeURIComponent(playerId)} mode ?`);
    const volumeResponse = await this.command(`${encodeURIComponent(playerId)} mixer volume ?`);

    return {
      id: playerId,
      name: firstSafeDisplayValue([decodeCliToken(nameResponse)], "Squeezebox player"),
      mode: firstSafeDisplayValue([decodeCliToken(modeResponse)], "stopped"),
      volume: Number(decodeURIComponent(lastToken(volumeResponse))) || 0,
      connected: true,
      online: true,
      detail: "LMS player connected"
    };
  }

  async nowPlaying(playerId) {
    if (!playerId) return null;
    const encoded = encodeURIComponent(playerId);
    const richStatus = await this.jsonRequest([playerId, ["status", "-", 1, "tags:Kcuoal"]]).catch(() => null);
    const status = richStatus?.result || {};
    const statusTrack = Array.isArray(status.playlist_loop) ? status.playlist_loop[0] : null;
    if ((!statusTrack && !status.current_title) || (statusTrack && !statusTrack.artist && !status.remoteMeta?.artist)) {
      return this.nowPlayingFromCli(encoded, playerId);
    }
    const artworkUrl = statusTrack?.artwork_url || status.remoteMeta?.artwork_url || "";
    const coverId = statusTrack?.coverid || status.remoteMeta?.coverid || "";
    const safeCoverId = coverId && coverId !== "0" ? String(coverId) : "";
    const decodedTitle = firstSafeDisplayValue([statusTrack?.title, status.current_title], "Unknown title");
    const streamTrack = trackFromStreamUrl(statusTrack?.url || statusTrack?.id || decodedTitle);
    return {
      id: streamTrack?.id || statusTrack?.url || statusTrack?.id || `lms:${decodedTitle}`,
      title: streamTrack?.title || decodedTitle,
      artist: streamTrack?.artist || firstSafeDisplayValue([statusTrack?.artist, status.remoteMeta?.artist], "Unknown artist"),
      album: streamTrack?.album || firstSafeDisplayValue([statusTrack?.album, status.remoteMeta?.album], ""),
      duration: Number(statusTrack?.duration) || Number(status.duration) || 0,
      elapsed: Number(status.time) || 0,
      canSeek: Boolean(status.can_seek),
      art: streamTrack?.art || (artworkUrl ? proxiedArtworkUrl(artworkUrl) : safeCoverId ? `api/artwork/${encodeURIComponent(safeCoverId)}` : null),
      source: streamTrack?.source || "LMS"
    };
  }

  async nowPlayingFromCli(encoded, playerId) {
    const [title, artist, album, duration, elapsed, richStatus] = await Promise.all([
      this.command(`${encoded} title ?`),
      this.command(`${encoded} artist ?`),
      this.command(`${encoded} album ?`),
      this.command(`${encoded} duration ?`),
      this.command(`${encoded} time ?`),
      this.jsonRequest([playerId, ["status", "-", 1, "tags:Kcuoal"]]).catch(() => null)
    ]);
    const status = richStatus?.result || {};
    const statusTrack = Array.isArray(status.playlist_loop) ? status.playlist_loop[0] : null;
    const artworkUrl = statusTrack?.artwork_url || status.remoteMeta?.artwork_url || "";
    const coverId = statusTrack?.coverid || status.remoteMeta?.coverid || "";
    const safeCoverId = coverId && coverId !== "0" ? String(coverId) : "";
    const decodedTitle = firstSafeDisplayValue([decodeCliToken(title), statusTrack?.title, status.current_title], "Unknown title");
    const streamTrack = trackFromStreamUrl(statusTrack?.url || statusTrack?.id || decodedTitle);
    return {
      id: streamTrack?.id || statusTrack?.url || statusTrack?.id || `lms:${decodedTitle}`,
      title: streamTrack?.title || decodedTitle,
      artist: streamTrack?.artist || firstSafeDisplayValue([decodeCliToken(artist), statusTrack?.artist], "Unknown artist"),
      album: streamTrack?.album || firstSafeDisplayValue([decodeCliToken(album), statusTrack?.album], ""),
      duration: Number(decodeURIComponent(lastToken(duration))) || Number(status.duration) || 0,
      elapsed: Number(decodeURIComponent(lastToken(elapsed))) || Number(status.time) || 0,
      canSeek: Boolean(status.can_seek),
      art: streamTrack?.art || (artworkUrl ? proxiedArtworkUrl(artworkUrl) : safeCoverId ? `api/artwork/${encodeURIComponent(safeCoverId)}` : null),
      source: streamTrack?.source || "LMS"
    };
  }

  async control(playerId, action, value) {
    if (!playerId) return null;
    const encoded = encodeURIComponent(playerId);
    const commandMap = {
      play: `${encoded} play`,
      pause: `${encoded} pause`,
      next: `${encoded} playlist index +1`,
      previous: `${encoded} playlist index -1`,
      volume: `${encoded} mixer volume ${Number(value)}`,
      seek: `${encoded} time ${Math.max(0, Number(value) || 0)}`,
      shuffle: `${encoded} playlist shuffle ${value ? 1 : 0}`,
      repeat: `${encoded} playlist repeat ${repeatValue(value)}`
    };
    if (!commandMap[action]) throw new Error(`Unsupported LMS action: ${action}`);
    return this.command(commandMap[action]);
  }

  async artwork(coverId) {
    if (!coverId) return null;
    const url = `${config.lmsHttpUrl.replace(/\/$/, "")}/music/${encodeURIComponent(coverId)}/cover.jpg`;
    const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs + 1800) });
    if (!response.ok) return null;
    return {
      contentType: response.headers.get("content-type") || "image/jpeg",
      bytes: Buffer.from(await response.arrayBuffer())
    };
  }

  async playTrack(playerId, track, action = "add") {
    if (!playerId || !track) return null;
    const target = await this.resolvePlayableTarget(track);
    if (!target) throw new Error("Track could not be resolved in LMS");

    if (target.type === "track_id") {
      const cmdMap = {
        "play-now": "load",
        "play-next": "insert",
        "add-queue": "add"
      };
      const result = await this.jsonRequest([playerId, ["playlistcontrol", `cmd:${cmdMap[action] || "add"}`, `track_id:${target.value}`]]);
      if (action === "play-now") await this.control(playerId, "play");
      return result;
    }

    const cmdMap = {
      "play-now": "play",
      "play-next": "insert",
      "add-queue": "add"
    };
    const playableUri = spottyPlaybackUri(target.value);
    const result = await this.command(`${encodeURIComponent(playerId)} playlist ${cmdMap[action] || "add"} ${playableUri}`);
    if (action === "play-now") await this.control(playerId, "play");
    return result;
  }

  async resolvePlayableTarget(track) {
    if (track.lmsTrackId) return { type: "track_id", value: track.lmsTrackId };
    if (track.uri && (!track.path || isSpotifySource(track))) return { type: "uri", value: track.uri };
    if (!track.path) return null;

    const indexed = await this.resolveIndexedTrack(track);
    if (indexed) return indexed;
    return { type: "uri", value: streamUrl(track.path) || fileUrl(track.path) };
  }

  async resolveIndexedTrack(track) {
    const cacheKey = track.path ? `trackId:${normalizePath(track.path)}` : "";
    const cached = cacheKey ? this.getCached(cacheKey) : null;
    if (cached) return cached;
    const exact = await this.resolveTrackIdByUrl(track.path);
    if (exact) {
      const target = { type: "track_id", value: exact };
      if (cacheKey) this.setCached(cacheKey, target, 15 * 60 * 1000);
      return target;
    }

    const title = track.title || path.parse(track.path).name;
    const searchTerms = uniqueSearchTerms([title, path.parse(track.path).name, path.basename(track.path, path.extname(track.path))]);
    const candidateGroups = await Promise.all(
      searchTerms.map((term) => this.jsonRequest(["", ["titles", 0, 100, `search:${term}`, "tags:ugal"]]).catch(() => null))
    );
    const candidates = candidateGroups.flatMap((response) => response?.result?.titles_loop || []);
    const normalizedPath = normalizePath(track.path);
    const normalizedBasename = normalizePath(path.basename(track.path));
    const match = candidates.find((item) => {
      const candidateUrl = normalizePath(decodeSafe(String(item.url || "")));
      return candidateUrl.endsWith(normalizedPath) || candidateUrl.endsWith(`/${normalizedBasename}`);
    });
    if (match?.id) {
      const target = { type: "track_id", value: match.id };
      if (cacheKey) this.setCached(cacheKey, target, 15 * 60 * 1000);
      return target;
    }

    const urlMatch = candidates.find((item) => normalizePath(decodeSafe(String(item.url || ""))).includes(normalizedBasename));
    if (urlMatch?.id) {
      const target = { type: "track_id", value: urlMatch.id };
      if (cacheKey) this.setCached(cacheKey, target, 15 * 60 * 1000);
      return target;
    }

    return null;
  }

  async resolveTrackIdByUrl(trackPath) {
    const response = await this.jsonRequest(["", ["songinfo", 0, 100, `url:${fileUrl(trackPath)}`]]).catch(() => null);
    const loop = response?.result?.songinfo_loop || [];
    for (const item of loop) {
      const id = item?.id || item?.track_id;
      if (id) return id;
    }
    return null;
  }

  async rescanLibrary() {
    const response = await this.jsonRequest(["", ["rescan"]]).catch(async () => null);
    if (response) return response;
    return this.command("rescan");
  }

  async spotifySearch(playerId, query, limit = 20) {
    if (!playerId || !String(query || "").trim()) return [];
    const count = Math.max(1, Math.min(50, Number(limit) || 20));
    const search = String(query).trim();
    const cacheKey = `spotifySearch:${playerId}:${search.toLowerCase()}:${count}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;
    let response = await this.jsonRequest([
      playerId,
      ["spotty", "items", 0, count, "menu:spotty", "item_id:1.0", `search:${search}`, "cachesearch:1"]
    ]);
    let items = response?.result?.item_loop || response?.result?.loop_loop || [];
    let playable = spotifyPlayableItems(items, "track");
    const directPlayable = [...playable];
    const categoryIds = items
      .map((item) => item.actions?.go?.params?.item_id)
      .filter((id) => /^1\.0_.*\.[012]$/.test(String(id)));
    const categoryResults = await Promise.all(
      categoryIds.map((itemId) =>
        this.jsonRequest([playerId, ["spotty", "items", 0, Math.min(10, count), "menu:spotty", `item_id:${itemId}`]]).catch(() => null)
      )
    );
    for (const category of categoryResults) {
      const title = String(category?.result?.title || "").toLowerCase();
      const kind = title.includes("artist") ? "artist" : title.includes("album") ? "album" : title.includes("playlist") ? "playlist" : "track";
      playable.push(...spotifyPlayableItems(category?.result?.item_loop || category?.result?.loop_loop || [], kind));
    }

    if (playable.length === 0) {
      const recent = items.find((item) => String(item.text || "").toLowerCase() === search.toLowerCase());
      const recentId = recent?.actions?.go?.params?.item_id;
      if (recentId) {
        response = await this.jsonRequest([playerId, ["spotty", "items", 0, count, "menu:spotty", `item_id:${recentId}`]]);
        items = response?.result?.item_loop || response?.result?.loop_loop || [];
        playable = spotifyPlayableItems(items, "track");
      }
    }

    const categoryPlayable = playable.filter((item) => item.resultKind !== "track");
    const firstPageTrackCount = Math.max(6, count - Math.min(12, categoryPlayable.length));
    const results = uniqueByUri([...directPlayable.slice(0, firstPageTrackCount), ...categoryPlayable, ...directPlayable.slice(firstPageTrackCount)])
      .map((item) => spotifyItemToTrack(item))
      .slice(0, count);
    this.setCached(cacheKey, results, spotifySearchCacheMs);
    return results;
  }

  async spotifyLibrary(playerId, type = "playlists", limit = 50, offset = 0) {
    if (!playerId) return [];
    const count = Math.max(1, Math.min(100, Number(limit) || 50));
    const start = Math.max(0, Number(offset) || 0);
    const cacheKey = `spotifyLibrary:${playerId}:${type}:${count}:${start}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;
    const widerCached = this.getCached(`spotifyLibrary:${playerId}:${type}:80:${start}`) || this.getCached(`spotifyLibrary:${playerId}:${type}:100:${start}`);
    if (widerCached && widerCached.length >= count) return widerCached.slice(0, count);
    const stale = this.getCached(cacheKey, { allowExpired: true }) || this.getCached(`spotifyLibrary:${playerId}:${type}:80:${start}`, { allowExpired: true })?.slice(0, count) || [];
    const itemMap = {
      playlists: { id: "8", kind: "playlist" },
      albums: { id: "6", kind: "album" },
      artists: { id: "7", kind: "artist" },
      tracks: { id: "3", kind: "track" },
      home: { id: "0", kind: "playlist" }
    };
    const selection = itemMap[type] || itemMap.playlists;
    const request = this.once(cacheKey, async () => {
      const response = await this.jsonRequest([playerId, ["spotty", "items", start, count, "menu:spotty", `item_id:${selection.id}`]]);
      const items = response?.result?.item_loop || response?.result?.loop_loop || [];
      const results = spotifyPlayableItems(items, selection.kind).map((item) => spotifyItemToTrack(item));
      this.setCached(cacheKey, results, spotifyBrowseCacheMs);
      return results;
    });
    const deadline = stale.length > 0 ? spotifyBrowseDeadlineMs : spotifyColdBrowseDeadlineMs;
    return (await withDeadline(request, deadline, stale)) || [];
  }

  async spotifyChildren(playerId, { browseId = "", uri = "", kind = "playlist" } = {}, limit = 100, offset = 0) {
    if (!playerId) return [];
    const count = Math.max(1, Math.min(300, Number(limit) || 100));
    const start = Math.max(0, Number(offset) || 0);
    const cacheKey = `spotifyChildren:${playerId}:${browseId}:${uri}:${kind}:${count}:${start}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;
    const stale = this.getCached(cacheKey, { allowExpired: true }) || [];
    const candidates = [browseId, uri].filter(Boolean);
    if (uri && !candidates.includes(uri.replace(/^spotify:/, "spotify://"))) candidates.push(uri.replace(/^spotify:/, "spotify://"));
    const request = this.once(cacheKey, async () => {
      for (const id of candidates) {
        const response = await this.jsonRequest([playerId, ["spotty", "items", start, count, "menu:spotty", `item_id:${id}`]]).catch(() => null);
        const items = response?.result?.item_loop || response?.result?.loop_loop || [];
        const tracks = spotifyPlayableItems(items, "track").map((item) => spotifyItemToTrack(item));
        if (tracks.length > 0) {
          this.setCached(cacheKey, tracks, spotifyBrowseCacheMs);
          return tracks;
        }
      }
      this.setCached(cacheKey, [], 30000);
      return [];
    });
    const deadline = stale.length > 0 ? spotifyBrowseDeadlineMs : spotifyColdBrowseDeadlineMs;
    const results = await withDeadline(request, deadline, stale);
    if (results?.length) return results;
    if (uri && kind === "track") return [{ id: uri, uri, title: "Spotify track", artist: "Spotify", source: "Spotify", kind: "track" }];
    return results || [];
  }

  async spotifyStatus() {
    try {
      const spotty = await this.detectSpottyFromConfig();
      if (spotty.configured) return spotty;

      const [favorites, serverStatus] = await Promise.all([
        this.command("favorites items 0 50 tags:py").catch(() => ""),
        this.command("serverstatus 0 500").catch(() => "")
      ]);
      const decoded = decodeURIComponent(`${favorites} ${serverStatus}`).toLowerCase();
      const hasSpotify = decoded.includes("spotify") || decoded.includes("spotty");
      return {
        configured: hasSpotify,
        reachable: true,
        detail: hasSpotify ? "Spotty plugin detected in LMS" : "LMS reachable, Spotty account not detected yet"
      };
    } catch (error) {
      return { configured: false, reachable: false, detail: error.message };
    }
  }

  async detectSpottyFromConfig() {
    const prefsPath = path.join(config.lmsConfigDir, "prefs", "plugin", "spotty.prefs");
    try {
      const prefs = await fs.readFile(prefsPath, "utf8");
      const normalized = prefs.toLowerCase();
      const hasAccount =
        /account:\s*\S+/i.test(prefs) ||
        /accounts:\s*[\s\S]*?(name|user|username|login|premium|import):/i.test(prefs) ||
        normalized.includes("ahmed") ||
        normalized.includes("premium");
      return {
        configured: hasAccount,
        reachable: true,
        detail: hasAccount
          ? "Spotty is installed and an authorized Spotify account is present in LMS"
          : "Spotty is installed, but no authorized account was found in LMS config"
      };
    } catch {
      return { configured: false, reachable: true, detail: "Spotty config file was not found in LMS config" };
    }
  }

  async musicInfoStatus() {
    try {
      const response = await this.command("serverstatus 0 200");
      const decoded = decodeURIComponent(response).toLowerCase();
      const detected = decoded.includes("musicartistinfo") || decoded.includes("music and artist") || decoded.includes("artist information");
      return {
        configured: detected,
        reachable: true,
        detail: detected
          ? "Music and Artist Information appears available in LMS"
          : "LMS reachable. Enable Music and Artist Information from LMS plugins for biographies, album reviews, and lyrics."
      };
    } catch (error) {
      return { configured: false, reachable: false, detail: error.message };
    }
  }

  async jsonRequest(params) {
    const response = await fetch(`${config.lmsHttpUrl.replace(/\/$/, "")}/jsonrpc.js`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, method: "slim.request", params }),
      signal: AbortSignal.timeout(this.timeoutMs + 800)
    });
    if (!response.ok) throw new Error(`LMS JSON request failed: ${response.status}`);
    return response.json();
  }

  getCached(key, { allowExpired = false } = {}) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (!allowExpired && item.expiresAt < Date.now()) {
      return null;
    }
    return structuredClone(item.value);
  }

  setCached(key, value, ttlMs) {
    if (this.cache.size > 200) this.cache.clear();
    this.cache.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttlMs });
  }

  once(key, work) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const promise = work().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}

function withDeadline(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function fileUrl(trackPath) {
  const normalized = String(trackPath).replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${absolute.split("/").map((part, index) => (index === 0 ? "" : encodeURIComponent(part))).join("/")}`;
}

function streamUrl(trackPath) {
  if (!trackPath) return null;
  const encoded = Buffer.from(String(trackPath)).toString("base64url");
  const name = encodeURIComponent(path.basename(String(trackPath)).replace(/[^\w .()'-]+/g, "_"));
  return `http://${config.lanLmsHost}:${config.port}/api/stream/${encoded}/${name}`;
}

function spottyPlaybackUri(value) {
  return String(value || "").replace(/^spotify:(track|episode):/i, "spotify://$1:");
}

function trackFromStreamUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const parts = url.pathname.split("/").filter(Boolean);
    const streamIndex = parts.findIndex((part) => part === "stream");
    const encoded = streamIndex >= 0 ? parts[streamIndex + 1] : "";
    if (!encoded) return null;
    const trackPath = Buffer.from(encoded, "base64url").toString("utf8");
    return fileToTrack(trackPath);
  } catch {
    return null;
  }
}

function proxiedArtworkUrl(value) {
  const raw = String(value || "");
  const match = raw.match(/^\/imageproxy\/(.+)\/image\.(?:png|jpg|jpeg|webp)$/i);
  const url = match ? decodeURIComponent(match[1]) : raw;
  if (!/^https?:\/\//i.test(url)) return null;
  return `api/image-proxy?url=${encodeURIComponent(url)}`;
}

function spotifyItemToTrack(item) {
  const uri = item.presetParams.favorites_url;
  const parsed = parseSpotifyText(item.presetParams.favorites_title || item.text || item.name || "Spotify track");
  const kind = item.resultKind || spotifyKind(uri, item.presetParams.favorites_type);
  return {
    id: uri,
    title: parsed.title,
    artist: parsed.artist,
    album: parsed.album,
    source: kind === "track" ? "Spotify" : `Spotify ${kind}`,
    uri,
    browseId: item.actions?.go?.params?.item_id || item.presetParams.item_id || item.params?.item_id || uri,
    art: item.presetParams.icon || item.icon || null,
    duration: null,
    kind
  };
}

function spotifyPlayableItems(items, kind = "track") {
  return items
    .filter((item) => item.presetParams?.favorites_url)
    .map((item) => ({ ...item, resultKind: spotifyKind(item.presetParams.favorites_url, item.presetParams.favorites_type, kind) }));
}

function parseSpotifyText(value) {
  const [titleLine, detailLine] = String(value).split(/\n/);
  const fallback = String(titleLine || value).match(/^(.*?) by (.*?) from (.*)$/);
  if (fallback) return { title: fallback[1], artist: fallback[2], album: fallback[3] };
  const byOnly = String(titleLine || value).match(/^(.*?) by (.*?)$/);
  if (byOnly) return { title: byOnly[1], artist: byOnly[2], album: "" };
  const [artist = "Spotify", album = ""] = String(detailLine || "").split(/\s+(?:â€¢|•)\s+/);
  return { title: titleLine || "Spotify track", artist, album };
}

function spotifyKind(uri, type, fallback = "track") {
  const value = String(uri || "");
  if (value.includes(":artist:")) return "artist";
  if (value.includes(":album:")) return "album";
  if (value.includes(":playlist:")) return "playlist";
  if (String(type || "").toLowerCase() === "playlist") return fallback === "track" ? "playlist" : fallback;
  return fallback;
}

function isSpotifySource(track) {
  return String(track?.source || "").toLowerCase().includes("spotify");
}

function uniqueByUri(items) {
  const seen = new Set();
  return items.filter((item) => {
    const uri = item.presetParams?.favorites_url;
    if (!uri || seen.has(uri)) return false;
    seen.add(uri);
    return true;
  });
}

function uniqueSearchTerms(values) {
  const seen = new Set();
  return values
    .map((value) => String(value || "").replace(/\.[a-z0-9]+$/i, "").trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function repeatValue(value) {
  if (value === "one") return 1;
  if (value === "all") return 2;
  return 0;
}

function decodeCliToken(response) {
  try {
    return decodeURIComponent(lastToken(response));
  } catch {
    return lastToken(response);
  }
}

function firstSafeDisplayValue(values, fallback) {
  for (const value of values) {
    const cleaned = cleanDisplayValue(value);
    if (cleaned) return cleaned;
  }
  return fallback;
}

function cleanDisplayValue(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || isCommandPayload(text)) return "";
  return text.slice(0, 180);
}

export function isCommandPayload(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return false;
  const commandMarkers = [
    "xstartprivateparty",
    "ui_mapname",
    "ui_gametype",
    "ui_zm_gamemodegroup",
    "ui_mapstartlocation",
    "ui_zm_mapstartlocation",
    "g_gametype",
    "set_gametype",
    "party_maxplayers",
    "party_maxplayers_privatematch",
    "sv_maxclients",
    "zm_cosmodrome"
  ];
  if (commandMarkers.some((marker) => text.includes(marker))) return true;
  if (/(^|[;\s])(?:seta?|set_|map)\s+[\w-]+/i.test(text)) return true;
  return text.split(";").length >= 4 && /\b(?:seta?|set_|map)\b/i.test(text);
}

function normalizePath(value) {
  return String(value || "")
    .replace(/^file:\/\//, "")
    .replace(/^tmp:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/%40/g, "@")
    .toLowerCase();
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function lastToken(response) {
  return String(response || "").trim().split(/\s+/).at(-1) || "";
}
