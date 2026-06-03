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
  }
  await assertLocalStream(search.results);
  await assertMalformedStreamRange(search.results);
  await assertBatchQueueAndShuffle();
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
  const localSearch = await requestJson("/library/search?source=local&limit=1");
  const manualTrack = (localSearch.results || []).find((item) => item.path);
  assert(manualTrack, "local library did not expose a playable track for smart shuffle keeper");
  const manual = await requestJson("/player/tracks", {
    method: "POST",
    body: {
      action: "add-queue",
      tracks: [
        { ...manualTrack, title: "Smoke Verify Manual Keeper", artist: "CloudSqueeze", source: "Local library" }
      ]
    }
  });
  for (const item of manual.queued || []) createdQueueIds.push(item.id);

  if (spotifyReachable) {
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
  assert((reset.queue || []).some((item) => item.title === "Smoke Verify Manual Keeper"), "turning smart queue off removed a manual queue row");

  await cleanupQueue();
  const after = await requestJson("/state");
  const leftovers = (after.queue || []).filter((item) => item.title?.startsWith("Smoke Verify "));
  assert(leftovers.length === 0, "smart shuffle smoke rows were not cleaned up");
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
  const sourceTracks = await localSmokeTracks(4);
  const tracks = sourceTracks.map((track, index) => smokeTrack(track, `Smoke Verify Limit ${index + 1}`));
  const rejected = await requestJson("/player/tracks", {
    method: "POST",
    body: { action: "add-queue", tracks }
  }, { expectedStatus: 429 });
  assert(String(rejected.error || "").includes("max 3"), "queue limit did not report the configured max");

  const allowed = await requestJson("/player/tracks", {
    method: "POST",
    body: { action: "add-queue", tracks: tracks.slice(0, 3) }
  });
  for (const item of allowed.queued || []) createdQueueIds.push(item.id);
  assert((allowed.queued || []).length === 3, "queue limit did not allow exactly three guest rows");

  const spoofed = await requestJson("/queue", {
    method: "POST",
    body: { title: "Smoke Verify Limit Spoof", artist: "CloudSqueeze", requestedBy: "admin" }
  }, { expectedStatus: 429 });
  assert(String(spoofed.error || "").includes("max 3"), "queue endpoint allowed requestedBy spoofing past the limit");
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

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
