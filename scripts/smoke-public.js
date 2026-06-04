const baseUrl = normalizeBaseUrl(process.env.PUBLIC_SMOKE_BASE_URL || "https://harmonizerlabs.cc/cloud-squeeze/api");
const createdQueueIds = [];
const latencyBudgetMs = Number(process.env.PUBLIC_SMOKE_LATENCY_BUDGET_MS || 900);

try {
  const latencyPaths = [
    "/health",
    "/state",
    "/speaker/status",
    "/spotify/status",
    "/library/search?limit=20",
    "/spotify/library?type=playlists&limit=8",
    "/spotify/library?type=albums&limit=5",
    "/spotify/library?type=home&limit=5"
  ];
  await warmLatencyPaths(latencyPaths);
  const latency = await measureLatency(latencyPaths);

  const health = await requestJson("/health");
  assert(health.ok === true, "health endpoint did not return ok=true");

  const spotifyStatus = await requestJson("/spotify/status");
  assert(spotifyStatus.configured === true, "Spotify/Spotty is not configured on public status");

  const state = await requestJson("/state");
  assert(state.player?.connected === true, "LMS player is not connected on public state");
  assert(state.services?.spotify?.configured === true, "Spotify/Spotty is not configured on public state");
  assert(Number(state.services?.localLibrary?.trackCount || 0) > 0, "public local library has no tracks");

  const search = await requestJson("/library/search?limit=5");
  assert(Array.isArray(search.results) && search.results.length > 0, "public library search returned no results");

  await assertMalformedJson();
  await assertInvalidPlaybackSettings();
  await assertQueueCrud();
  await assertPlayableDuplicateRejection();
  await assertQueueLimit();
  await assertSpotifyContainersCannotPlayDirectly();
  const spotifyReachable = spotifyStatus.reachable !== false && state.services?.spotify?.reachable !== false;
  if (!spotifyReachable) {
    await assertSpotifyUnavailableResponses();
    console.log(`Spotify content checks skipped: ${spotifyStatus.detail || state.services?.spotify?.detail || "Spotify browsing unavailable"}`);
  } else {
    await assertSpotifyContainersOpenToTracks();
    await assertSpotifyLibrarySections();
    await assertSpotifyPagination();
  }
  await assertLocalCollectionPagination();
  await assertLocalStream(search.results);
  await assertMalformedStreamRange(search.results);
  await assertBatchQueueAndShuffle();
  await assertRapidManagedControls();
  await assertSmartShuffleSources({ spotifyReachable });

  const slow = latency.filter((row) => row.avgMs > latencyBudgetMs);
  assert(slow.length === 0, `latency budget exceeded: ${slow.map((row) => `${row.path} avg ${row.avgMs}ms`).join(", ")}`);

  console.log("Public smoke ok");
  console.table(latency);
} catch (error) {
  await cleanupQueue();
  console.error(`Public smoke failed: ${error.message}`);
  process.exit(1);
}

async function assertBatchQueueAndShuffle() {
  await cleanupQueue();
  const smokeTracks = await localSmokeTracks(5);
  const batch = await requestJson("/player/tracks", {
    method: "POST",
    body: {
      action: "add-queue",
      tracks: [
        smokeTrack(smokeTracks[0], "Smoke Verify One"),
        smokeTrack(smokeTracks[1], "Smoke Verify Two")
      ]
    }
  });
  for (const item of batch.queued || []) createdQueueIds.push(item.id);
  assert(
    (batch.queued || []).map((item) => item.title).join("|") === "Smoke Verify One|Smoke Verify Two",
    "batch queue did not preserve order"
  );
  await cleanupQueue();

  const playNext = await requestJson("/player/tracks", {
    method: "POST",
    body: {
      action: "play-next",
      tracks: [
        smokeTrack(smokeTracks[2], "Smoke Verify Three"),
        smokeTrack(smokeTracks[3], "Smoke Verify Four"),
        smokeTrack(smokeTracks[4], "Smoke Verify Five")
      ]
    }
  });
  for (const item of playNext.queued || []) createdQueueIds.push(item.id);
  assert(
    (playNext.queued || []).map((item) => item.title).join("|") === "Smoke Verify Three|Smoke Verify Four|Smoke Verify Five",
    "play-next batch response did not preserve playlist order"
  );
  assert(
    (playNext.queue || []).slice(0, 3).map((item) => item.title).join("|") === "Smoke Verify Three|Smoke Verify Four|Smoke Verify Five",
    "play-next batch did not place playlist songs at the front in order"
  );

  const playback = await requestJson("/player/playback", {
    method: "POST",
    body: { shuffle: true, smartQueue: false, smartShuffleSource: "spotify" }
  });
  const generatedRows = (playback.queue || []).filter((item) => item.requestedBy === "shuffle" || item.requestedBy === "smart shuffle");
  assert(playback.playback?.shuffle === true, "regular shuffle did not turn on");
  assert(playback.playback?.smartQueue === false, "regular shuffle also enabled smart queue");
  assert(generatedRows.length === 0, "regular shuffle generated unrelated queue rows");

  await cleanupQueue();
  const reset = await requestJson("/player/playback", {
    method: "POST",
    body: { shuffle: false, smartQueue: false }
  });
  assert(reset.playback?.shuffle === false && reset.playback?.smartQueue === false, "playback reset did not disable generated modes");

  const after = await requestJson("/state");
  const leftovers = (after.queue || []).filter((item) => item.title?.startsWith("Smoke Verify "));
  assert(leftovers.length === 0, "smoke queue rows were not cleaned up");
}

async function assertSmartShuffleSources({ spotifyReachable } = {}) {
  await cleanupQueue();
  const localSearch = await requestJson("/library/search?source=local&limit=4");
  const localTracks = (localSearch.results || []).filter((item) => item.path);
  const manualTrack = localTracks[0];
  assert(manualTrack, "local library did not expose a playable track for smart shuffle blocker");
  const manual = await requestJson("/player/tracks", {
    method: "POST",
    body: {
      action: "add-queue",
      tracks: [
        { ...manualTrack, title: "Smoke Verify Manual Blocker", artist: "CloudSqueeze", source: "Local library" }
      ]
    }
  });
  for (const item of manual.queued || []) createdQueueIds.push(item.id);

  if (spotifyReachable) {
    const blocked = await requestJson("/player/smart-shuffle", {
      method: "POST",
      body: { source: "spotify", count: 3, seed: "drake" }
    }, { expectedStatus: 409 });
    assert((blocked.queued || []).length === 0, "manual queue smart-shuffle rejection queued rows");
    assert(String(blocked.error || "").includes("Clear the queue"), "manual queue smart-shuffle rejection returned an unexpected error");

    await cleanupQueue();
    const spotify = await requestJson("/player/smart-shuffle", {
      method: "POST",
      body: { source: "spotify", count: 3, seed: "drake" }
    });
    const spotifyRows = (spotify.queued || []).filter((item) => item.requestedBy === "smart shuffle");
    assert(spotify.playback?.smartQueue === true, "spotify smart shuffle did not enable smart queue");
    assert(spotify.playback?.smartShuffleSource === "spotify", "spotify smart shuffle did not set spotify source");
    assert(spotifyRows.length > 0, "spotify smart shuffle did not queue generated rows");
    assert(spotifyRows.every((item) => String(item.uri || "").includes(":track:") && !item.path), "spotify smart shuffle queued non-Spotify tracks");
  } else {
    const spotify = await requestJson("/player/smart-shuffle", {
      method: "POST",
      body: { source: "spotify", count: 3, seed: "drake" }
    }, { expectedStatus: 503 });
    assert((spotify.queued || []).length === 0, "unavailable spotify smart shuffle queued rows");
  }

  const local = await requestJson("/player/smart-shuffle", {
    method: "POST",
    body: { source: "local", count: 3, seed: "juice" }
  });
  const localRows = (local.queued || []).filter((item) => item.requestedBy === "smart shuffle");
  assert(local.playback?.smartQueue === true, "local smart shuffle did not leave smart queue enabled");
  assert(local.playback?.smartShuffleSource === "local", "local smart shuffle did not set local source");
  assert(localRows.length > 0, "local smart shuffle did not queue generated rows");
  assert(localRows.every((item) => item.path && !item.uri), "local smart shuffle queued Spotify or non-local tracks");

  const reset = await requestJson("/player/playback", {
    method: "POST",
    body: { smartQueue: false, shuffle: false }
  });
  const generatedAfterReset = (reset.queue || []).filter((item) => item.requestedBy === "smart shuffle" || item.requestedBy === "shuffle");
  assert(generatedAfterReset.length === 0, "turning smart queue off left generated rows behind");

  await cleanupQueue();
  const after = await requestJson("/state");
  const leftovers = (after.queue || []).filter((item) => item.title?.startsWith("Smoke Verify "));
  assert(leftovers.length === 0, "smart shuffle smoke rows were not cleaned up");
}

async function assertSpotifyPagination() {
  const library = await requestJson("/spotify/library?type=playlists&limit=8");
  const playlists = (library.results || []).filter((item) => item.kind === "playlist" && (item.uri || item.browseId));
  assert(playlists.length > 0, "Spotify pagination check did not find playlist containers");
  for (const playlist of playlists) {
    const params = spotifyChildParams(playlist, 3, 0);
    const first = await requestJson(`/spotify/children?${params.toString()}`);
    const secondParams = spotifyChildParams(playlist, 3, 3);
    const second = await requestJson(`/spotify/children?${secondParams.toString()}`);
    const firstTracks = (first.results || []).filter((item) => !item.kind || item.kind === "track");
    const secondTracks = (second.results || []).filter((item) => !item.kind || item.kind === "track");
    if (firstTracks.length === 0 || secondTracks.length === 0) continue;
    const secondKeys = new Set(secondTracks.map(playableKey).filter(Boolean));
    const overlap = firstTracks.some((item) => secondKeys.has(playableKey(item)));
    assert(!overlap, "Spotify playlist pagination returned overlapping tracks");
    return;
  }
  assert(false, "Spotify pagination check could not find two populated playlist pages");
}

async function assertLocalCollectionPagination() {
  const body = await requestJson("/library/collections?source=local");
  const collection = (body.collections || []).find((item) => Number(item.count || 0) >= 6);
  assert(collection, "local collection pagination check did not find a collection with enough tracks");
  const firstParams = new URLSearchParams({
    source: "local",
    collection: collection.collection || "",
    folder: collection.folder || "",
    limit: "3",
    offset: "0"
  });
  const secondParams = new URLSearchParams(firstParams);
  secondParams.set("offset", "3");
  const first = await requestJson(`/library/collection?${firstParams.toString()}`);
  const second = await requestJson(`/library/collection?${secondParams.toString()}`);
  const firstTracks = first.results || [];
  const secondTracks = second.results || [];
  assert(firstTracks.length === 3 && secondTracks.length === 3, "local collection pagination did not return full pages");
  const secondKeys = new Set(secondTracks.map(playableKey).filter(Boolean));
  const overlap = firstTracks.some((item) => secondKeys.has(playableKey(item)));
  assert(!overlap, "local collection pagination returned overlapping tracks");
}

async function assertRapidManagedControls() {
  await resetPublicPlayback();
  const tracks = await localSmokeTracks(4);
  await requestJson("/player/track", {
    method: "POST",
    body: { action: "play-now", track: smokeTrack(tracks[0], "Smoke Verify Control One") }
  });
  await requestJson("/player/tracks", {
    method: "POST",
    body: {
      action: "add-queue",
      tracks: [
        smokeTrack(tracks[1], "Smoke Verify Control Two"),
        smokeTrack(tracks[2], "Smoke Verify Control Three"),
        smokeTrack(tracks[3], "Smoke Verify Control Four")
      ]
    }
  });
  await delay(600);
  const responses = [];
  for (const path of ["/player/next", "/player/next", "/player/previous", "/player/next"]) {
    responses.push(await requestJson(path, { method: "POST", body: {} }));
  }
  const actions = responses.map((item) => item.action);
  assert(actions.join("|") === "visible-queue-next|visible-queue-next|app-previous|visible-queue-next", `rapid controls returned unexpected actions: ${actions.join("|")}`);
  const state = await requestJson("/state");
  assert(state.nowPlaying?.title === "Smoke Verify Control Three", "rapid controls ended on the wrong song");
  assert((state.queue || []).map((item) => item.title).join("|") === "Smoke Verify Control Four", "rapid controls left the wrong visible queue");
  assert(state.playback?.appManagedPlayback === true, "rapid controls dropped app-managed playback");
  await resetPublicPlayback();
}

async function assertQueueCrud() {
  const title = `Smoke Verify Crud ${Date.now()}`;
  const [track] = await localSmokeTracks(1);
  const item = smokeTrack(track, title);
  const created = await requestJson("/queue", {
    method: "POST",
    body: item
  }, { expectedStatus: 201 });
  createdQueueIds.push(created.id);

  const duplicate = await requestJson("/queue", {
    method: "POST",
    body: item
  }, { expectedStatus: 409 });
  assert(duplicate.error === "That song is already in the queue", "duplicate queue item did not return the expected error");

  const edited = await requestJson(`/queue/${encodeURIComponent(created.id)}`, {
    method: "PATCH",
    body: { title: `${title} Edited`, artist: "Verifier" }
  });
  assert(edited.item?.title === `${title} Edited` && edited.item?.artist === "Verifier", "queue edit did not persist");

  const moved = await requestJson(`/queue/${encodeURIComponent(created.id)}/move`, {
    method: "POST",
    body: { direction: "up" }
  });
  assert(moved.item?.id === created.id, "queue move did not return the target item");
}

async function assertPlayableDuplicateRejection() {
  await cleanupQueue();
  const title = `Smoke Verify Duplicate ${Date.now()}`;
  const [track] = await localSmokeTracks(1);
  const item = smokeTrack(track, title);
  const first = await requestJson("/player/tracks", {
    method: "POST",
    body: {
      action: "add-queue",
      tracks: [item]
    }
  });
  for (const item of first.queued || []) createdQueueIds.push(item.id);
  assert((first.queued || []).length === 1, "first duplicate smoke insert did not queue one row");

  const duplicate = await requestJson("/player/tracks", {
    method: "POST",
    body: {
      action: "add-queue",
      tracks: [item]
    }
  }, { expectedStatus: 409 });
  assert(duplicate.error === "Those songs are already in the queue", "batch duplicate rejection returned an unexpected error");
  await cleanupQueue();
}

async function assertQueueLimit() {
  await cleanupQueue();
  const state = await requestJson("/state");
  const limit = Number(state.admin?.maxQueuePerUser || 3);
  assert(Number.isInteger(limit) && limit > 0, "state did not expose a valid queue limit");
  const sourceTracks = await localSmokeTracks(limit + 1);
  const tracks = sourceTracks.map((track, index) => smokeTrack(track, `Smoke Verify Limit ${index + 1}`));
  const limited = await requestJson("/player/tracks", {
    method: "POST",
    body: { action: "add-queue", tracks }
  });
  for (const item of limited.queued || []) createdQueueIds.push(item.id);
  assert((limited.queued || []).length === limit, `queue limit did not accept exactly ${limit} rows from an over-limit batch`);
  assert(limited.accepted === limit && limited.rejected === 1, "queue limit did not report partial batch acceptance");

  const spoofed = await requestJson("/queue", {
    method: "POST",
    body: { title: "Smoke Verify Limit Spoof", artist: "CloudSqueeze", requestedBy: "admin" }
  }, { expectedStatus: 429 });
  assert(String(spoofed.error || "").includes(`max ${limit}`), "queue endpoint allowed requestedBy spoofing past the limit");
  await cleanupQueue();
}

async function assertSpotifyContainersOpenToTracks() {
  const library = await requestJson("/spotify/library?type=playlists&limit=8");
  const playlists = (library.results || []).filter((item) => item.kind === "playlist" && (item.uri || item.browseId)).slice(0, 5);
  assert(playlists.length > 0, "Spotify playlist library did not expose a playlist container");

  const attempts = [];
  for (const playlist of playlists) {
    const params = new URLSearchParams();
    if (playlist.browseId) params.set("browseId", String(playlist.browseId));
    if (playlist.uri) params.set("uri", String(playlist.uri));
    params.set("kind", "playlist");
    params.set("limit", "25");
    const children = await requestJson(`/spotify/children?${params.toString()}`);
    const tracks = (children.results || []).filter((item) => !item.kind || item.kind === "track");
    attempts.push(`${playlist.title || playlist.uri}:${tracks.length}`);
    if (tracks.length > 0) {
      assert(tracks.every((item) => String(item.uri || "").includes(":track:")), "Spotify playlist children included non-track items");
      return;
    }
  }
  assert(false, `Spotify playlist children did not expose playable tracks (${attempts.join(", ")})`);
}

async function assertSpotifyLibrarySections() {
  const albums = await requestJson("/spotify/library?type=albums&limit=5");
  assert(Array.isArray(albums.results), "Spotify albums library did not return a results array");
  assert((albums.results || []).every((item) => item.kind === "album" && String(item.uri || "").includes(":album:")), "Spotify albums library returned non-album items");

  const home = await requestJson("/spotify/library?type=home&limit=5");
  assert(Array.isArray(home.results), "Spotify home library did not return a results array");
  assert((home.results || []).every((item) => item.kind !== "track" || String(item.uri || "").includes(":track:")), "Spotify home library returned malformed track items");
}

async function assertSpotifyContainersCannotPlayDirectly() {
  const rejected = await requestJson("/player/track", {
    method: "POST",
    body: {
      action: "play-now",
      track: {
        id: "spotify:playlist:smoke-container",
        title: "Smoke Container",
        artist: "Spotify",
        source: "Spotify playlist",
        uri: "spotify:playlist:smoke-container",
        kind: "playlist"
      }
    }
  }, { expectedStatus: 400 });
  assert(rejected.error === "Playable local path, LMS track id, or Spotify URI is required", "Spotify container direct-play rejection returned an unexpected error");
}

async function assertSpotifyUnavailableResponses() {
  const endpoints = [
    "/spotify/search?q=drake&limit=8",
    "/spotify/library?type=playlists&limit=8",
    "/spotify/children?uri=spotify%3Aplaylist%3Asmoke&kind=playlist&limit=8"
  ];
  for (const endpoint of endpoints) {
    const started = performance.now();
    const body = await requestJson(endpoint);
    const elapsed = Math.round(performance.now() - started);
    assert(Array.isArray(body.results), `${endpoint} did not return a results array while Spotify is unavailable`);
    assert(body.results.length === 0, `${endpoint} returned results while Spotify is unavailable`);
    assert(elapsed < 500, `${endpoint} was too slow while Spotify is unavailable: ${elapsed}ms`);
  }
}

async function assertLocalStream(searchResults) {
  const local = (searchResults || []).find((item) => item.path);
  assert(local, "public library search did not return a local playable path");
  const encoded = Buffer.from(local.path, "utf8").toString("base64url");
  const response = await fetch(`${baseUrl}/stream/${encoded}/${encodeURIComponent(local.title || "track")}`, {
    headers: { range: "bytes=0-31" },
    signal: AbortSignal.timeout(15000)
  });
  await response.arrayBuffer();
  assert(response.status === 206, `local stream range returned HTTP ${response.status}, expected 206`);
  assert(response.headers.get("content-range")?.startsWith("bytes 0-"), "local stream range missing content-range header");
}

async function assertMalformedStreamRange(searchResults) {
  const local = (searchResults || []).find((item) => item.path);
  assert(local, "public library search did not return a local playable path for malformed range test");
  const encoded = Buffer.from(local.path, "utf8").toString("base64url");
  const started = performance.now();
  const response = await fetch(`${baseUrl}/stream/${encoded}/${encodeURIComponent(local.title || "track")}`, {
    headers: { range: "bad-range" },
    signal: AbortSignal.timeout(15000)
  });
  await response.arrayBuffer();
  const elapsed = Math.round(performance.now() - started);
  assert(response.status === 416, `malformed stream range returned HTTP ${response.status}, expected 416`);
  assert(elapsed < 1000, `malformed stream range was too slow: ${elapsed}ms`);
}

async function assertMalformedJson() {
  const response = await fetch(`${baseUrl}/player/playback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{bad-json",
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.json().catch(() => ({}));
  assert(response.status === 400, `malformed JSON returned ${response.status}, expected 400`);
  assert(body.error === "Invalid JSON request body", "malformed JSON response was not compact JSON");
}

async function assertInvalidPlaybackSettings() {
  const rejected = await requestJson("/player/playback", {
    method: "POST",
    body: { repeat: "bad", shuffle: "yes", smartQueue: "no", smartShuffleSource: "bad" }
  }, { expectedStatus: 400 });
  assert(rejected.error === "Invalid playback settings", "invalid playback settings returned an unexpected error");
}

async function cleanupQueue() {
  while (createdQueueIds.length > 0) {
    const id = createdQueueIds.pop();
    await fetch(`${baseUrl}/queue/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(8000)
    }).catch(() => null);
  }
}

async function resetPublicPlayback() {
  await requestJson("/player/playback", {
    method: "POST",
    body: { shuffle: false, smartQueue: false, repeat: "off", smartShuffleSource: "mixed" }
  }).catch(() => null);
  await requestJson("/queue", { method: "DELETE" }).catch(() => null);
  await requestJson("/player/stop", { method: "POST", body: {} }).catch(() => null);
  createdQueueIds.splice(0, createdQueueIds.length);
  await delay(400);
}

async function measureLatency(paths) {
  const rows = [];
  for (const path of paths) {
    const samples = [];
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now();
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(15000) });
      await response.arrayBuffer();
      assert(response.ok, `${path} returned HTTP ${response.status}`);
      samples.push(Math.round(performance.now() - started));
    }
    rows.push({
      path,
      minMs: Math.min(...samples),
      avgMs: Math.round(samples.reduce((sum, item) => sum + item, 0) / samples.length),
      maxMs: Math.max(...samples)
    });
  }
  return rows;
}

async function warmLatencyPaths(paths) {
  for (const path of paths) {
    await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(15000) })
      .then((response) => response.arrayBuffer())
      .catch(() => null);
  }
}

async function requestJson(path, { method = "GET", body } = {}, { expectedStatus = 200 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (expectedStatus) {
    assert(response.status === expectedStatus, `${path} returned HTTP ${response.status}, expected ${expectedStatus}: ${text.slice(0, 160)}`);
  } else {
    assert(response.ok, `${path} returned HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  return data;
}

async function localSmokeTracks(count) {
  const body = await requestJson(`/library/search?source=local&limit=${Math.max(20, count)}`);
  const tracks = (body.results || []).filter((item) => item.path);
  assert(tracks.length >= count, `local library returned ${tracks.length} playable tracks, needed ${count}`);
  return tracks.slice(0, count);
}

function smokeTrack(track, title) {
  return {
    ...track,
    title,
    artist: "CloudSqueeze",
    source: track.source || "Local library"
  };
}

function spotifyChildParams(playlist, limit, offset) {
  const params = new URLSearchParams();
  if (playlist.browseId) params.set("browseId", String(playlist.browseId));
  if (playlist.uri) params.set("uri", String(playlist.uri));
  params.set("kind", "playlist");
  if (playlist.title) params.set("title", String(playlist.title));
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return params;
}

function playableKey(track) {
  return String(track?.uri || track?.path || track?.lmsTrackId || track?.id || `${track?.title || ""}:${track?.artist || ""}`).toLowerCase();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
