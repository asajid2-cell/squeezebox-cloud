import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./state.js";
import { fileToTrack } from "./library.js";

const spotifySearchCacheMs = 2 * 60 * 1000;
const spotifyBrowseCacheMs = 5 * 60 * 1000;
const spotifyStatusCacheMs = Number(process.env.SPOTIFY_STATUS_CACHE_MS || 30000);
const spotifyBrowseDeadlineMs = Number(process.env.SPOTIFY_BROWSE_DEADLINE_MS || 1800);
const spotifyColdBrowseDeadlineMs = Number(process.env.SPOTIFY_COLD_BROWSE_DEADLINE_MS || 6500);
const spotifyChildrenColdBrowseDeadlineMs = Number(process.env.SPOTIFY_CHILDREN_COLD_BROWSE_DEADLINE_MS || 4000);
const spotifySearchCategoryDeadlineMs = Number(process.env.SPOTIFY_SEARCH_CATEGORY_DEADLINE_MS || 650);

export class LmsClient {
  constructor(options = {}) {
    this.host = options.host || config.lmsHost;
    this.port = options.port || config.lmsCliPort;
    this.timeoutMs = options.timeoutMs || 3500;
    this.cache = new Map();
    this.inflight = new Map();
    this.spotifyBrowseIds = new Map();
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
    const jsonStatus = await this.statusFromJson().catch(() => null);
    if (jsonStatus) return jsonStatus;

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

  async statusFromJson() {
    const playersResponse = await this.jsonRequest(["", ["players", 0, 10]]);
    const players = playersResponse?.result?.players_loop || [];
    if (!Array.isArray(players) || players.length < 1) {
      return { connected: false, online: true, detail: "LMS online, no player connected" };
    }
    const player = players.find((candidate) => candidate?.connected !== 0) || players[0];
    const playerId = String(player.playerid || "").trim();
    if (!playerId) return null;
    const statusResponse = await this.jsonRequest([playerId, ["status", "-", 1]]);
    const status = statusResponse?.result || {};
    return {
      id: playerId,
      name: firstSafeDisplayValue([status.player_name, player.name], "Squeezebox player"),
      mode: firstSafeDisplayValue([status.mode], "stopped"),
      volume: Number(status["mixer volume"]) || 0,
      connected: status.player_connected !== 0 && player.connected !== 0,
      online: true,
      detail: "LMS player connected"
    };
  }

  async nowPlaying(playerId) {
    if (!playerId) return null;
    const encoded = encodeURIComponent(playerId);
    const richStatus = await this.jsonRequest([playerId, ["status", "-", 1, "tags:Kcuoal"]]).catch(() => null);
    const status = richStatus?.result || {};
    if (isIdleStatus(status)) return idleTrack();
    const statusTrack = Array.isArray(status.playlist_loop) ? status.playlist_loop[0] : null;
    if ((!statusTrack && !status.current_title) || (statusTrack && !statusTrack.artist && !status.remoteMeta?.artist)) {
      return this.nowPlayingFromCli(encoded, playerId);
    }
    const artworkUrl = statusTrack?.artwork_url || status.remoteMeta?.artwork_url || "";
    const coverId = statusTrack?.coverid || status.remoteMeta?.coverid || "";
    const safeCoverId = coverId && coverId !== "0" ? String(coverId) : "";
    const decodedTitle = firstSafeDisplayValue([statusTrack?.title, status.current_title], "Unknown title");
    const streamTrack = trackFromStreamUrl(statusTrack?.url || statusTrack?.id || decodedTitle);
    const spotifyTrack = spotifyTrackFromStatusValue(statusTrack?.url || statusTrack?.id);
    return {
      id: streamTrack?.id || spotifyTrack?.id || statusTrack?.url || statusTrack?.id || `lms:${decodedTitle}`,
      title: streamTrack?.title || decodedTitle,
      artist: streamTrack?.artist || firstSafeDisplayValue([statusTrack?.artist, status.remoteMeta?.artist], "Unknown artist"),
      album: streamTrack?.album || firstSafeDisplayValue([statusTrack?.album, status.remoteMeta?.album], ""),
      duration: Number(statusTrack?.duration) || Number(status.duration) || 0,
      elapsed: Number(status.time) || 0,
      canSeek: Boolean(status.can_seek),
      art: streamTrack?.art || (artworkUrl ? proxiedArtworkUrl(artworkUrl) : safeCoverId ? `api/artwork/${encodeURIComponent(safeCoverId)}` : null),
      source: streamTrack?.source || spotifyTrack?.source || "LMS",
      uri: spotifyTrack?.uri,
      kind: spotifyTrack?.kind
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
    if (isIdleStatus(status)) return idleTrack();
    const statusTrack = Array.isArray(status.playlist_loop) ? status.playlist_loop[0] : null;
    const artworkUrl = statusTrack?.artwork_url || status.remoteMeta?.artwork_url || "";
    const coverId = statusTrack?.coverid || status.remoteMeta?.coverid || "";
    const safeCoverId = coverId && coverId !== "0" ? String(coverId) : "";
    const decodedTitle = firstSafeDisplayValue([decodeCliToken(title), statusTrack?.title, status.current_title], "Unknown title");
    const streamTrack = trackFromStreamUrl(statusTrack?.url || statusTrack?.id || decodedTitle);
    const spotifyTrack = spotifyTrackFromStatusValue(statusTrack?.url || statusTrack?.id);
    return {
      id: streamTrack?.id || spotifyTrack?.id || statusTrack?.url || statusTrack?.id || `lms:${decodedTitle}`,
      title: streamTrack?.title || decodedTitle,
      artist: streamTrack?.artist || firstSafeDisplayValue([decodeCliToken(artist), statusTrack?.artist], "Unknown artist"),
      album: streamTrack?.album || firstSafeDisplayValue([decodeCliToken(album), statusTrack?.album], ""),
      duration: Number(decodeURIComponent(lastToken(duration))) || Number(status.duration) || 0,
      elapsed: Number(decodeURIComponent(lastToken(elapsed))) || Number(status.time) || 0,
      canSeek: Boolean(status.can_seek),
      art: streamTrack?.art || (artworkUrl ? proxiedArtworkUrl(artworkUrl) : safeCoverId ? `api/artwork/${encodeURIComponent(safeCoverId)}` : null),
      source: streamTrack?.source || spotifyTrack?.source || "LMS",
      uri: spotifyTrack?.uri,
      kind: spotifyTrack?.kind
    };
  }

  async control(playerId, action, value) {
    if (!playerId) return null;
    const encoded = encodeURIComponent(playerId);
    const commandMap = {
      play: `${encoded} play`,
      pause: `${encoded} pause`,
      stop: `${encoded} stop`,
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
    // LMS accepts an optional title for the item — set it so archived HTTP
    // streams show "Artist - Title" instead of the raw URL.
    const titleArg = target.title ? ` ${encodeURIComponent(target.title)}` : "";
    const result = await this.command(`${encodeURIComponent(playerId)} playlist ${cmdMap[action] || "add"} ${playableUri}${titleArg}`);
    if (action === "play-now") await this.control(playerId, "play");
    return result;
  }

  // Squeezebox Tap: load and play a WHOLE album, from the top or starting at a
  // chosen track. Uses NATIVE LMS album loading (never a manual per-track queue):
  //  - local albums  -> `playlistcontrol cmd:load album_id:<id>` (JSON-RPC)
  //  - Spotify albums -> Spotty's `playlist play spotify://album:<id>` (CLI)
  // An optional 0-based `startIndex` jumps to that track after the album loads,
  // which is the album-from-track ("start at the representative song") case.
  async loadAlbum(playerId, spec = {}) {
    if (!playerId || !spec) return null;
    const rawIndex = Number(spec.startIndex);
    const startIndex = Number.isFinite(rawIndex) ? Math.max(0, Math.floor(rawIndex)) : 0;
    const source = String(spec.source || (spec.albumUri ? "spotify" : "local")).toLowerCase();
    // Party-queue mode: APPEND the album to the running playlist instead of
    // replacing it (no index jump, no forced play — the current track keeps going).
    const queue = Boolean(spec.queue);

    if (source === "spotify") {
      const albumUri = String(spec.albumUri || "");
      if (!/^spotify:album:[A-Za-z0-9]+$/i.test(albumUri)) {
        throw new Error("A spotify:album:<id> URI is required to load a Spotify album");
      }
      const encoded = encodeURIComponent(playerId);
      if (queue) {
        await this.command(`${encoded} playlist add ${albumUri}`);
        return { source: "spotify", albumUri, queued: true };
      }
      // Spotty plays a Spotify ALBUM via the plain `spotify:album:<id>` form —
      // NOT the `spotify://album:` slash form that tracks use (that one silently
      // loads 0 tracks). Verified against the live Spotty/LMS.
      await this.command(`${encoded} playlist play ${albumUri}`);
      if (startIndex > 0) await this.command(`${encoded} playlist index ${startIndex}`);
      await this.control(playerId, "play");
      return { source: "spotify", albumUri, startIndex };
    }

    const albumId = String(spec.albumId || "");
    if (!albumId) throw new Error("An album_id is required to load a local album");
    if (queue) {
      await this.jsonRequest([playerId, ["playlistcontrol", "cmd:add", `album_id:${albumId}`]]);
      return { source: "local", albumId, queued: true };
    }
    // Native atomic album load. `play_index:N` on cmd:load starts playback AT that
    // track in one command (LMS docs) — avoids the race where a follow-up
    // `playlist index N` runs before the playlist is populated.
    const loadArgs = ["playlistcontrol", "cmd:load", `album_id:${albumId}`];
    if (startIndex > 0) loadArgs.push(`play_index:${startIndex}`);
    await this.jsonRequest([playerId, loadArgs]);
    await this.control(playerId, "play");
    return { source: "local", albumId, startIndex };
  }

  // Load (or, in queue mode, append) a whole Spotify playlist. Like albums,
  // Spotty wants the plain `spotify:playlist:<id>` colon form — the slash form
  // silently loads nothing.
  async loadPlaylist(playerId, spec = {}) {
    if (!playerId || !spec) return null;
    const playlistUri = String(spec.playlistUri || "");
    if (!/^spotify:playlist:[A-Za-z0-9]+$/i.test(playlistUri)) {
      throw new Error("A spotify:playlist:<id> URI is required to load a Spotify playlist");
    }
    const encoded = encodeURIComponent(playerId);
    if (spec.queue) {
      await this.command(`${encoded} playlist add ${playlistUri}`);
      return { source: "spotify", playlistUri, queued: true };
    }
    await this.command(`${encoded} playlist play ${playlistUri}`);
    await this.control(playerId, "play");
    return { source: "spotify", playlistUri };
  }

  // Where the player currently is in its playlist — the live track index and
  // elapsed seconds. Used to bookmark a resume-enabled tag before switching away.
  async playlistPosition(playerId) {
    if (!playerId) return null;
    const encoded = encodeURIComponent(playerId);
    const idxRaw = Number(lastToken(await this.command(`${encoded} playlist index ?`)));
    const timeRaw = Number(decodeURIComponent(lastToken(await this.command(`${encoded} time ?`))));
    return {
      index: Number.isFinite(idxRaw) && idxRaw >= 0 ? Math.floor(idxRaw) : 0,
      seconds: Number.isFinite(timeRaw) && timeRaw >= 0 ? Math.floor(timeRaw) : 0
    };
  }

  async resolvePlayableTarget(track) {
    // Archived FLACs live outside the LMS library; play them as an HTTP stream
    // served by our own /api/archive/file endpoint (exempt from the https redirect
    // so LMS can pull it over plain HTTP on the LAN).
    const archiveId = String(track.id || "");
    if (archiveId.startsWith("archive:")) {
      const filename = archiveId.slice("archive:".length);
      const titleParts = [track.artist, track.title].filter(Boolean).join(" - ");
      return {
        type: "uri",
        value: `http://${config.lanLmsHost}:${config.port}/api/archive/file/${encodeURIComponent(filename)}`,
        title: titleParts || filename.replace(/\.flac$/i, "")
      };
    }
    // Harmonizer canon/jukebox live-drive stream (the reverse bridge): an endless
    // HTTP stream served by Cloud Squeeze's own /api/canon-stream proxy (which pulls
    // from Harmonizer). Exempt from the https redirect so LMS can pull it over plain
    // HTTP on the LAN — same mechanism as archive: streams above.
    if (archiveId.startsWith("canon:")) {
      const canonTrackId = archiveId.slice("canon:".length);
      const params = new URLSearchParams();
      if (track.canonMode) params.set("mode", String(track.canonMode));
      if (track.canonVoices) params.set("voiceCount", String(track.canonVoices));
      if (track.canonSeed) params.set("seed", String(track.canonSeed));
      const qs = params.toString();
      const titleParts = [track.artist, track.title].filter(Boolean).join(" - ");
      return {
        type: "uri",
        value: `http://${config.lanLmsHost}:${config.port}/api/canon-stream/${encodeURIComponent(canonTrackId)}${qs ? `?${qs}` : ""}`,
        title: titleParts || "Harmonizer canon"
      };
    }
    if (track.lmsTrackId) return { type: "track_id", value: track.lmsTrackId };
    if (track.uri && (!track.path || isSpotifySource(track))) {
      if (!isSpotifyTrackUri(track.uri)) return null;
      return { type: "uri", value: track.uri };
    }
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
    const match = candidates.find((item) => {
      const candidateUrl = normalizePath(decodeSafe(String(item.url || "")));
      return candidateUrl.endsWith(normalizedPath);
    });
    if (match?.id) {
      const target = { type: "track_id", value: match.id };
      if (cacheKey) this.setCached(cacheKey, target, 15 * 60 * 1000);
      return target;
    }

    return null;
  }

  async enrichLocalArtwork(tracks, { limit = 40, concurrency = 6, deadlineMs = 0 } = {}) {
    if (!Array.isArray(tracks) || tracks.length === 0) return tracks;
    const results = tracks.slice();
    const deadlineAt = Number(deadlineMs) > 0 ? Date.now() + Number(deadlineMs) : 0;
    const candidates = tracks
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => track?.path && !track?.uri && !track?.art)
      .slice(0, Math.max(0, Number(limit) || 0));

    for (let offset = 0; offset < candidates.length; offset += concurrency) {
      if (deadlineAt && Date.now() >= deadlineAt) return results;
      const batch = Promise.all(
        candidates.slice(offset, offset + concurrency).map(async ({ track, index }) => {
          const cacheKey = `localArt:${normalizePath(track.path)}`;
          const cached = this.getCached(cacheKey);
          if (cached) {
            if (cached.art) results[index] = { ...track, art: cached.art };
            return;
          }

          const art = await this.localArtworkForTrack(track).catch(() => null);
          this.setCached(cacheKey, { art }, 30 * 60 * 1000);
          if (art) results[index] = { ...track, art };
        })
      );
      if (deadlineAt) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) return results;
        const completed = await Promise.race([batch.then(() => true), sleep(remaining).then(() => false)]);
        if (!completed) return results;
      } else {
        await batch;
      }
    }

    return results;
  }

  async localArtworkForTrack(track) {
    const title = track?.title || (track?.path ? path.parse(track.path).name : "");
    if (!title || !track?.path) return null;
    const response = await this.jsonRequest(["", ["titles", 0, 20, `search:${title}`, "tags:Kcuoal"]]);
    const loop = response?.result?.titles_loop || [];
    const normalizedPath = normalizePath(track.path);
    const match = loop.find((item) => normalizePath(decodeSafe(String(item.url || ""))) === normalizedPath);
    const coverId = match?.coverid && String(match.coverid) !== "0" ? String(match.coverid) : "";
    return coverId ? `api/artwork/${encodeURIComponent(coverId)}` : null;
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
    const search = normalizeSearchQuery(query);
    const cacheKey = `spotifySearch:${playerId}:${search.toLowerCase()}:${count}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;
    if (looksLikeRandomSingleTokenNoise(search)) {
      this.setCached(cacheKey, [], 30000);
      return [];
    }
    const requestCount = Math.max(count, 20);
    const requestKey = `spotifySearch:${playerId}:${search.toLowerCase()}:${requestCount}`;
    const widerKeys = requestCount < 50
      ? [requestKey, `spotifySearch:${playerId}:${search.toLowerCase()}:50`]
      : [requestKey];
    const widerCached = widerKeys
      .map((key) => this.getCached(key))
      .find((results) => results && results.length >= count);
    if (widerCached && widerCached.length >= count) return widerCached.slice(0, count);
    const stale =
      this.getCached(cacheKey, { allowExpired: true }) ||
      widerKeys.map((key) => this.getCached(key, { allowExpired: true })).find((results) => results && results.length >= count)?.slice(0, count) ||
      [];
    const widerInflight = widerKeys.map((key) => this.inflight.get(key)).find(Boolean);
    if (widerInflight) {
      if (stale.length > 0) return stale.slice(0, count);
      const results = await widerInflight.catch(() => null);
      if (results && results.length >= count) return results.slice(0, count);
    }
    const request = this.once(requestKey, async () => {
      let response = await this.jsonRequest([
        playerId,
        ["spotty", "items", 0, requestCount, "menu:spotty", "item_id:1.0", `search:${search}`, "cachesearch:1"]
      ]);
      let items = response?.result?.item_loop || response?.result?.loop_loop || [];
      let playable = spotifyPlayableItems(items, "track");
      const directPlayable = [...playable];
      const categoryIds = items
        .map((item) => item.actions?.go?.params?.item_id)
        .filter((id) => /^1\.0_.*\.[012]$/.test(String(id)));
      const categoryDeadline = directPlayable.length > 0 ? spotifySearchCategoryDeadlineMs : spotifyBrowseDeadlineMs;
      const categoryResults = categoryIds.length > 0
        ? await withDeadline(
          Promise.all(
            categoryIds.map((itemId) =>
              this.jsonRequest([playerId, ["spotty", "items", 0, Math.min(10, requestCount), "menu:spotty", `item_id:${itemId}`]]).catch(() => null)
            )
          ),
          categoryDeadline,
          []
        )
        : [];
      for (const category of categoryResults) {
        const title = String(category?.result?.title || "").toLowerCase();
        const kind = title.includes("artist") ? "artist" : title.includes("album") ? "album" : title.includes("playlist") ? "playlist" : "track";
        playable.push(...spotifyPlayableItems(category?.result?.item_loop || category?.result?.loop_loop || [], kind));
      }

      if (playable.length === 0) {
        const recent = items.find((item) => String(item.text || "").toLowerCase() === search.toLowerCase());
        const recentId = recent?.actions?.go?.params?.item_id;
        if (recentId) {
          response = await this.jsonRequest([playerId, ["spotty", "items", 0, requestCount, "menu:spotty", `item_id:${recentId}`]]);
          items = response?.result?.item_loop || response?.result?.loop_loop || [];
          playable = spotifyPlayableItems(items, "track");
        }
      }

      const categoryPlayable = playable.filter((item) => item.resultKind !== "track");
      const firstPageTrackCount = Math.max(6, count - Math.min(12, categoryPlayable.length));
      const mapped = filterSpotifySearchResults(
        uniqueByUri([...directPlayable.slice(0, firstPageTrackCount), ...categoryPlayable, ...directPlayable.slice(firstPageTrackCount)])
          .map((item) => spotifyItemToTrack(item)),
        search
      );
      if (mapped.length > 0) this.setCached(requestKey, mapped.slice(0, requestCount), spotifySearchCacheMs);
      else if (looksLikeSingleTokenNoise(search)) this.setCached(requestKey, [], 30000);
      return mapped;
    });
    if (stale.length > 0) {
      request
        .then((fresh) => {
          this.rememberSpotifyBrowseIds(fresh);
          const results = fresh.slice(0, count);
          if (results.length > 0) this.setCached(cacheKey, results, spotifySearchCacheMs);
        })
        .catch(() => null);
      return stale.slice(0, count);
    }
    const fullResults = await request;
    this.rememberSpotifyBrowseIds(fullResults);
    const results = fullResults.slice(0, count);
    if (results.length > 0) {
      this.setCached(cacheKey, results, spotifySearchCacheMs);
    } else if (looksLikeSingleTokenNoise(search)) {
      this.setCached(cacheKey, [], 30000);
    }
    return results;
  }

  // Resolves the artist/album/playlist category buckets for a Spotify search.
  // Kept separate from spotifySearch so track results stay fast; this can take
  // longer (each bucket is its own Spotty drill) and is fetched in parallel by
  // the client. Results are cached so repeat searches are instant.
  async spotifySearchCategories(playerId, query, limit = 8) {
    const empty = { artists: [], albums: [], playlists: [] };
    if (!playerId || !String(query || "").trim()) return empty;
    const count = Math.max(1, Math.min(20, Number(limit) || 8));
    const search = normalizeSearchQuery(query);
    if (looksLikeRandomSingleTokenNoise(search)) return empty;
    const cacheKey = `spotifySearchCategories:${playerId}:${search.toLowerCase()}:${count}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;
    return this.once(cacheKey, async () => {
      const response = await this.jsonRequest([
        playerId,
        ["spotty", "items", 0, 30, "menu:spotty", "item_id:1.0", `search:${search}`, "cachesearch:1"]
      ]);
      const items = response?.result?.item_loop || response?.result?.loop_loop || [];
      const idForLabel = (label) =>
        items.find((item) => String(item.text || "").trim().toLowerCase() === label)?.actions?.go?.params?.item_id || "";
      const buckets = [
        ["artist", "artists", idForLabel("artists")],
        ["album", "albums", idForLabel("albums")],
        ["playlist", "playlists", idForLabel("playlists")]
      ];
      const fetched = await Promise.all(
        buckets.map(async ([kind, , itemId]) => {
          if (!itemId) return [];
          const result = await this.jsonRequest([
            playerId,
            ["spotty", "items", 0, count, "menu:spotty", `item_id:${itemId}`]
          ]).catch(() => null);
          const loop = result?.result?.item_loop || result?.result?.loop_loop || [];
          return spotifyPlayableItems(loop, kind).map((item) => spotifyItemToTrack(item));
        })
      );
      const categories = { artists: fetched[0], albums: fetched[1], playlists: fetched[2] };
      if (categories.artists.length || categories.albums.length || categories.playlists.length) {
        this.rememberSpotifyBrowseIds([...categories.artists, ...categories.albums, ...categories.playlists]);
        this.setCached(cacheKey, categories, spotifySearchCacheMs);
      }
      return categories;
    });
  }

  async spotifyRecommendationCandidates(playerId, seedArtists = [], options = {}) {
    if (!playerId) return [];
    const seeds = uniqueSearchTerms(Array.isArray(seedArtists) ? seedArtists : [seedArtists]).slice(0, 5);
    if (seeds.length === 0) return [];
    const limit = Math.max(1, Math.min(250, Number(options.limit) || 80));
    const relatedArtistsPerSeed = Math.max(0, Math.min(6, Number(options.relatedArtistsPerSeed) || 3));
    const relatedTracksPerArtist = Math.max(0, Math.min(60, Number(options.relatedTracksPerArtist) || 18));
    const fallbackLimit = Math.max(0, Math.min(80, Number(options.fallbackLimit) || Math.min(40, limit)));
    const cacheKey = `spotifyRecommendationCandidates:${playerId}:${seeds.map((seed) => seed.toLowerCase()).join("|")}:${limit}:${relatedArtistsPerSeed}:${relatedTracksPerArtist}:${fallbackLimit}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const request = this.once(cacheKey, async () => {
      const pool = [];
      for (const seed of seeds) {
        if (pool.length >= limit) break;
        const artist = await this.findSpotifyArtistForSeed(playerId, seed).catch(() => null);
        if (!artist?.browseId) continue;
        const detail = await this.spotifyBrowseItems(playerId, artist.browseId, 16).catch(() => null);
        const detailItems = spottyLoop(detail);
        const artistRadio = findSpottyItemByText(detailItems, "artist radio");
        const topTracks = findSpottyItemByText(detailItems, "top tracks");
        const relatedArtists = findSpottyItemByText(detailItems, "related artists");

        const radioTracks = await this.spotifyTracksFromBrowseItem(playerId, artistRadio, Math.min(200, Math.max(limit * 2, 60)), {
          seed,
          recommendationSource: "artist-radio"
        });
        const radioLead = relatedArtistsPerSeed > 0 ? Math.min(radioTracks.length, Math.max(16, Math.ceil(limit * 0.7))) : radioTracks.length;
        pool.push(...radioTracks.slice(0, radioLead));
        if (pool.length < Math.max(12, limit / 2)) {
          pool.push(...await this.spotifyTracksFromBrowseItem(playerId, topTracks, 20, { seed, recommendationSource: "artist-top-tracks" }));
        }

        if (relatedArtistsPerSeed > 0) {
          const related = await this.spotifyBrowseItemTracksOrContainers(playerId, relatedArtists, 25, "artist").catch(() => []);
          const relatedPool = related.slice(0, relatedArtistsPerSeed);
          for (const relatedArtist of relatedPool) {
            const relatedDetail = await this.spotifyBrowseItems(playerId, relatedArtist.browseId, 16).catch(() => null);
            const relatedDetailItems = spottyLoop(relatedDetail);
            const relatedTopTracks = findSpottyItemByText(relatedDetailItems, "top tracks");
            const relatedRadio = findSpottyItemByText(relatedDetailItems, "artist radio");
            pool.push(...await this.spotifyTracksFromBrowseItem(playerId, relatedTopTracks, Math.min(20, relatedTracksPerArtist), {
              seed,
              recommendationSource: "related-artist-top-tracks",
              relatedArtist: relatedArtist.title
            }));
            if (pool.length < limit) {
              pool.push(...await this.spotifyTracksFromBrowseItem(playerId, relatedRadio, relatedTracksPerArtist, {
                seed,
                recommendationSource: "related-artist-radio",
                relatedArtist: relatedArtist.title
              }));
            }
          }
        }
        pool.push(...radioTracks.slice(radioLead));
      }

      let candidates = uniqueTrackCandidates(pool).slice(0, limit);
      if (candidates.length < Math.min(limit, 12) && fallbackLimit > 0) {
        const fallbackBatches = await Promise.all(
          seeds.slice(0, 3).map((seed) => this.spotifySearch(playerId, seed, fallbackLimit).catch(() => []))
        );
        candidates = uniqueTrackCandidates([
          ...candidates,
          ...fallbackBatches.flat().map((track) => ({ ...track, recommendationSource: "global-search-fallback" }))
        ]).slice(0, limit);
      }
      if (candidates.length > 0) {
        this.rememberSpotifyBrowseIds(candidates);
        this.setCached(cacheKey, candidates, spotifyBrowseCacheMs);
      }
      return candidates;
    });

    const stale = this.getCached(cacheKey, { allowExpired: true }) || [];
    const results = stale.length > 0
      ? await withDeadline(request, spotifyBrowseDeadlineMs, stale)
      : await request;
    return results || [];
  }

  async findSpotifyArtistForSeed(playerId, seed) {
    const search = normalizeSearchQuery(seed);
    if (!search || looksLikeRandomSingleTokenNoise(search)) return null;
    const response = await this.spotifyBrowseItems(playerId, "1.0", 30, 0, [`search:${search}`, "cachesearch:1"]);
    const items = spottyLoop(response);
    const artistsBucket = findSpottyItemByText(items, "artists");
    const artists = await this.spotifyBrowseItemTracksOrContainers(playerId, artistsBucket, 20, "artist");
    if (artists.length === 0) return null;
    return bestArtistMatch(artists, search) || artists[0];
  }

  async spotifyBrowseItems(playerId, itemId, limit = 50, offset = 0, extraParams = []) {
    if (!playerId || !itemId) return null;
    const count = Math.max(1, Math.min(300, Number(limit) || 50));
    const start = Math.max(0, Number(offset) || 0);
    return this.jsonRequest([
      playerId,
      ["spotty", "items", start, count, "menu:spotty", `item_id:${itemId}`, ...extraParams]
    ]);
  }

  async spotifyTracksFromBrowseItem(playerId, item, limit, metadata = {}) {
    return this.spotifyBrowseItemTracksOrContainers(playerId, item, limit, "track", metadata);
  }

  async spotifyBrowseItemTracksOrContainers(playerId, item, limit = 50, kind = "track", metadata = {}) {
    const itemId = spottyItemId(item);
    if (!itemId) return [];
    const response = await this.spotifyBrowseItems(playerId, itemId, limit);
    const items = spottyLoop(response);
    return spotifyPlayableItems(items, kind)
      .map((entry) => ({ ...spotifyItemToTrack(entry), ...metadata }))
      .filter((track) => kind !== "track" || (track.kind === "track" && String(track.uri || "").includes(":track:")));
  }

  async spotifyLibrary(playerId, type = "playlists", limit = 50, offset = 0) {
    if (!playerId) return [];
    const count = Math.max(1, Math.min(100, Number(limit) || 50));
    const start = Math.max(0, Number(offset) || 0);
    const shouldWiden = start === 0 && count < 80 && ["playlists", "home"].includes(type);
    const requestCount = shouldWiden ? 80 : count;
    const cacheKey = `spotifyLibrary:${playerId}:${type}:${count}:${start}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;
    const requestKey = `spotifyLibrary:${playerId}:${type}:${requestCount}:${start}`;
    const widerKeys = [...new Set([requestKey, `spotifyLibrary:${playerId}:${type}:80:${start}`, `spotifyLibrary:${playerId}:${type}:100:${start}`])];
    const widerCached = this.getCached(widerKeys[0]) || this.getCached(widerKeys[1]);
    if (widerCached && widerCached.length >= count) return widerCached.slice(0, count);
    if (start > 0) {
      const firstPageCached = [`spotifyLibrary:${playerId}:${type}:80:0`, `spotifyLibrary:${playerId}:${type}:100:0`]
        .map((key) => this.getCached(key))
        .find((results) => results && results.length >= start + count);
      if (firstPageCached) return firstPageCached.slice(start, start + count);
    }
    const stale = this.getCached(cacheKey, { allowExpired: true }) || this.getCached(widerKeys[0], { allowExpired: true })?.slice(0, count) || [];
    if (type === "albums") return stale.slice(0, count);
    const widerInflight = widerKeys.map((key) => this.inflight.get(key)).find(Boolean);
    if (widerInflight) {
      const deadline = stale.length > 0 ? spotifyBrowseDeadlineMs : spotifyColdBrowseDeadlineMs;
      return (await withDeadline(widerInflight.then((results) => results.slice(0, count)), deadline, stale)) || [];
    }
    const itemMap = {
      playlists: { id: "8", kind: "playlist" },
      albums: { id: "6", kind: "album" },
      artists: { id: "7", kind: "artist" },
      tracks: { id: "3", kind: "track" },
      home: { id: "0", kind: "playlist" }
    };
    const selection = itemMap[type] || itemMap.playlists;
    const request = this.once(requestKey, async () => {
      const response = await this.jsonRequest([playerId, ["spotty", "items", start, requestCount, "menu:spotty", `item_id:${selection.id}`]]);
      const items = response?.result?.item_loop || response?.result?.loop_loop || [];
      const results = spotifyPlayableItems(items, selection.kind).map((item) => spotifyItemToTrack(item));
      this.rememberSpotifyBrowseIds(results);
      if (results.length > 0) this.setCached(requestKey, results, spotifyBrowseCacheMs);
      return results;
    });
    const deadline = stale.length > 0 ? spotifyBrowseDeadlineMs : spotifyColdBrowseDeadlineMs;
    const results = await withDeadline(request, deadline, stale);
    return (results || []).slice(0, count);
  }

  async spotifyChildren(playerId, { browseId = "", uri = "", kind = "playlist", title = "" } = {}, limit = 100, offset = 0) {
    if (!playerId) return [];
    const count = Math.max(1, Math.min(300, Number(limit) || 100));
    const start = Math.max(0, Number(offset) || 0);
    const shouldWiden = start === 0 && count < 200 && kind !== "track";
    const requestCount = shouldWiden ? 200 : count;
    const fallbackTitle = String(title || "").trim();
    const normalizedFallbackTitle = comparableSpotifyText(fallbackTitle);
    const resolvedBrowseId = String(browseId || this.spotifyBrowseIds.get(normalizedSpotifyUri(uri)) || "");
    const cacheBase = `spotifyChildren:${playerId}:${resolvedBrowseId}:${uri}:${kind}:${normalizedFallbackTitle}`;
    const cacheKey = `${cacheBase}:${count}:${start}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached;
    const requestKey = `${cacheBase}:${requestCount}:${start}`;
    const widerKeys = [...new Set([requestKey, `${cacheBase}:200:${start}`, `${cacheBase}:300:${start}`])];
    const widerCached = widerKeys
      .map((key) => this.getCached(key))
      .find((results) => results && (results.length === 0 || results.length >= count));
    if (widerCached) return widerCached.slice(0, count);
    if (start > 0) {
      const firstPageCached = [`${cacheBase}:200:0`, `${cacheBase}:300:0`]
        .map((key) => this.getCached(key))
        .find((results) => results && results.length >= start + count);
      if (firstPageCached) return firstPageCached.slice(start, start + count);
    }
    const stale =
      this.getCached(cacheKey, { allowExpired: true }) ||
      widerKeys
        .map((key) => this.getCached(key, { allowExpired: true }))
        .find((results) => results && (results.length === 0 || results.length >= count))?.slice(0, count) ||
      [];
    const widerInflight = widerKeys.map((key) => this.inflight.get(key)).find(Boolean);
    const coldDeadline = kind === "artist" && fallbackTitle ? spotifyColdBrowseDeadlineMs : spotifyChildrenColdBrowseDeadlineMs;
    if (widerInflight) {
      const deadline = stale.length > 0 ? spotifyBrowseDeadlineMs : coldDeadline;
      return (await withDeadline(widerInflight.then((results) => results.slice(0, count)), deadline, stale)) || [];
    }
    const candidates = [resolvedBrowseId, uri].filter(Boolean);
    if (uri && !candidates.includes(uri.replace(/^spotify:/, "spotify://"))) candidates.push(uri.replace(/^spotify:/, "spotify://"));
    const request = this.once(requestKey, async () => {
      if (kind === "artist" && fallbackTitle) {
        const fallbackTracks = (await this.spotifySearch(playerId, fallbackTitle, Math.min(20, count)).catch(() => []))
          .filter((track) => track.kind === "track" && String(track.uri || "").includes(":track:"));
        const matchingArtistTracks = normalizedFallbackTitle
          ? fallbackTracks.filter((track) => {
              const artist = comparableSpotifyText(track.artist);
              return artist.includes(normalizedFallbackTitle) || normalizedFallbackTitle.includes(artist);
            })
          : [];
        const tracks = matchingArtistTracks.length > 0 ? matchingArtistTracks : fallbackTracks;
        if (tracks.length > 0) {
          this.setCached(requestKey, tracks, spotifyBrowseCacheMs);
          return tracks;
        }
      }
      for (const id of candidates) {
        const response = await this.jsonRequest([playerId, ["spotty", "items", start, requestCount, "menu:spotty", `item_id:${id}`]]).catch(() => null);
        const items = response?.result?.item_loop || response?.result?.loop_loop || [];
        const tracks = spotifyPlayableItems(items, "track")
          .map((item) => spotifyItemToTrack(item))
          .filter((track) => track.kind === "track" && String(track.uri || "").includes(":track:"));
        if (tracks.length > 0) {
          this.setCached(requestKey, tracks, spotifyBrowseCacheMs);
          return tracks;
        }
      }
      this.setCached(requestKey, [], 30000);
      return [];
    });
    const deadline = stale.length > 0 ? spotifyBrowseDeadlineMs : coldDeadline;
    const results = await withDeadline(request, deadline, stale);
    if (results?.length) return results.slice(0, count);
    if (uri && kind === "track" && isSpotifyTrackUri(uri)) return [{ id: uri, uri, title: "Spotify track", artist: "Spotify", source: "Spotify", kind: "track" }];
    return results || [];
  }

  rememberSpotifyBrowseIds(tracks = []) {
    for (const track of tracks || []) {
      const uri = normalizedSpotifyUri(track?.uri);
      const browseId = String(track?.browseId || "");
      if (!uri || !browseId || browseId === track?.uri) continue;
      if (!/^spotify:(playlist|album|artist):/i.test(uri)) continue;
      this.spotifyBrowseIds.set(uri, browseId);
    }
    if (this.spotifyBrowseIds.size > 1000) {
      for (const key of this.spotifyBrowseIds.keys()) {
        this.spotifyBrowseIds.delete(key);
        if (this.spotifyBrowseIds.size <= 800) break;
      }
    }
  }

  async spotifyStatus() {
    const cacheKey = "spotifyStatus";
    const cached = this.getCached(cacheKey);
    if (cached) return cached;
    const stale = this.getCached(cacheKey, { allowExpired: true });
    const request = this.once(cacheKey, async () => {
      const status = await this.readSpotifyStatus();
      this.setCached(cacheKey, status, spotifyStatusCacheMs);
      return status;
    });
    if (stale) {
      request.catch(() => null);
      return stale;
    }
    return request;
  }

  async readSpotifyStatus() {
    try {
      const spotty = await this.detectSpottyFromConfig();
      if (spotty.configured) {
        return { ...spotty, ...(await this.verifySpottyAvailability()) };
      }

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

  async verifySpottyAvailability() {
    const playerCountResponse = await this.command("player count ?").catch(() => "");
    const playerCount = Number(lastToken(playerCountResponse));
    if (!Number.isFinite(playerCount) || playerCount < 1) {
      return {
        reachable: false,
        detail: "Spotty is configured, but no LMS player is connected for Spotify browsing"
      };
    }

    const playerIdResponse = await this.command("player id 0 ?");
    const playerId = decodeURIComponent(lastToken(playerIdResponse));
    const browseRoots = ["playlists", "home"];
    for (const type of browseRoots) {
      const results = await this.spotifyLibrary(playerId, type, 1, 0).catch(() => []);
      if (results.length > 0) {
        return {
          reachable: true,
          detail: "Spotty is installed and Spotify browsing is responding"
        };
      }
    }

    const responses = await withDeadline(
      Promise.all([
        this.jsonRequest([playerId, ["spotty", "items", 0, 6, "menu:spotty", "item_id:0"]]).catch(() => null),
        this.jsonRequest([playerId, ["spotty", "items", 0, 6, "menu:spotty", "item_id:8"]]).catch(() => null)
      ]),
      Math.min(this.timeoutMs + 700, 2200),
      []
    );
    const items = (responses || []).flatMap((response) => response?.result?.item_loop || response?.result?.loop_loop || []);
    if (spotifyPlayableItems(items, "track").length > 0 || items.some(hasSpottyNavigationAction)) {
      return {
        reachable: true,
        detail: "Spotty is installed and Spotify browsing is responding"
      };
    }

    const text = items.map((item) => String(item.text || item.name || "")).join(" ").toLowerCase();
    return {
      reachable: false,
      detail: text.includes("empty")
        ? "Spotty is configured, but Spotify returned an empty browsing response. Reauthorize Spotty in LMS."
        : "Spotty is configured, but Spotify browsing is not responding. Reauthorize Spotty in LMS."
    };
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

function isSpotifyTrackUri(value) {
  return /^(spotify:track:|spotify:\/\/track:)[A-Za-z0-9]{22}$/i.test(String(value || ""));
}

function spotifyTrackFromStatusValue(value) {
  const raw = String(value || "");
  if (!isSpotifyTrackUri(raw)) return null;
  return {
    id: raw,
    uri: raw.replace(/^spotify:\/\/track:/i, "spotify:track:"),
    source: "Spotify",
    kind: "track"
  };
}

function normalizedSpotifyUri(value) {
  return String(value || "")
    .replace(/^spotify:\/\/(playlist|album|artist|track):/i, "spotify:$1:")
    .toLowerCase();
}

function normalizeSearchQuery(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function filterSpotifySearchResults(results, query) {
  if (!looksLikeSingleTokenNoise(query)) return results;
  return results.filter((track) => spotifySearchResultMatches(track, query));
}

function looksLikeSingleTokenNoise(query) {
  const normalized = comparableSpotifyText(query);
  return normalized.length >= 8 && !normalized.includes(" ");
}

function looksLikeRandomSingleTokenNoise(query) {
  const normalized = comparableSpotifyText(query);
  if (normalized.length < 10 || normalized.includes(" ")) return false;
  if (/\d/.test(normalized)) return false;
  const vowels = normalized.match(/[aeiou]/g)?.length || 0;
  const vowelRatio = vowels / normalized.length;
  const rareLetters = normalized.match(/[qzx]/g)?.length || 0;
  if (vowelRatio < 0.18 && rareLetters > 0) return true;
  if (/[qzx][qzx]|[bcdfghjklmnpqrstvwxyz]{5,}/.test(normalized)) return true;
  return false;
}

function spotifySearchResultMatches(track, query) {
  const normalizedQuery = comparableSpotifyText(query);
  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const haystack = comparableSpotifyText([track?.title, track?.artist, track?.album].filter(Boolean).join(" "));
  const compactHaystack = haystack.replace(/\s+/g, "");
  return haystack.includes(normalizedQuery) || compactHaystack.includes(compactQuery);
}

function isIdleStatus(status) {
  const mode = String(status?.mode || "").toLowerCase();
  const playlistTracks = Number(status?.playlist_tracks);
  return mode === "stop" || mode === "stopped" || playlistTracks === 0;
}

function idleTrack() {
  return {
    id: "idle",
    title: "No track playing",
    artist: "Connect a player or request a song",
    album: "",
    source: "LMS",
    duration: 0,
    elapsed: 0,
    canSeek: false,
    art: null
  };
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
    art: spotifyArtworkUrl(item.presetParams.icon || item.icon),
    duration: null,
    kind
  };
}

function spottyLoop(response) {
  const loop = response?.result?.item_loop || response?.result?.loop_loop || [];
  return Array.isArray(loop) ? loop : [];
}

function spottyItemId(item) {
  return String(item?.actions?.go?.params?.item_id || item?.params?.item_id || item?.presetParams?.item_id || "").trim();
}

function spottyItemText(item) {
  return String(item?.text || item?.name || item?.presetParams?.favorites_title || "").split(/\n/)[0].trim();
}

function findSpottyItemByText(items, label) {
  const target = comparableSpotifyText(label);
  return (items || []).find((item) => comparableSpotifyText(spottyItemText(item)) === target) ||
    (items || []).find((item) => comparableSpotifyText(spottyItemText(item)).includes(target)) ||
    null;
}

function bestArtistMatch(artists, seed) {
  const target = comparableSpotifyText(seed);
  if (!target) return null;
  return artists.find((artist) => comparableSpotifyText(artist.title) === target) ||
    artists.find((artist) => {
      const title = comparableSpotifyText(artist.title);
      return title && (title.includes(target) || target.includes(title));
    }) ||
    null;
}

function spotifyPlayableItems(items, kind = "track") {
  return items
    .filter((item) => item.presetParams?.favorites_url)
    .map((item) => ({ ...item, resultKind: spotifyKind(item.presetParams.favorites_url, item.presetParams.favorites_type, kind) }));
}

function spotifyArtworkUrl(value) {
  return proxiedArtworkUrl(value) || value || null;
}

function hasSpottyNavigationAction(item) {
  const action = String(item?.action || "").toLowerCase();
  const style = String(item?.style || "").toLowerCase();
  const itemId = item?.actions?.go?.params?.item_id || item?.params?.item_id;
  return Boolean(itemId) && action !== "none" && !style.includes("itemnoaction");
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

function uniqueTrackCandidates(items) {
  const seen = new Set();
  return (items || []).filter((track) => {
    const uri = normalizedSpotifyUri(track?.uri);
    const fallback = `${comparableSpotifyText(track?.title)}:${comparableSpotifyText(track?.artist)}`;
    const key = uri || fallback;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function comparableSpotifyText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function lastToken(response) {
  return String(response || "").trim().split(/\s+/).at(-1) || "";
}
