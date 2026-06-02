const baseUrl = normalizeBaseUrl(process.env.PUBLIC_SMOKE_BASE_URL || "https://harmonizerlabs.cc/cloud-squeeze/api");
const createdQueueIds = [];
const latencyBudgetMs = Number(process.env.PUBLIC_SMOKE_LATENCY_BUDGET_MS || 900);

try {
  const latency = await measureLatency([
    "/health",
    "/state",
    "/speaker/status",
    "/spotify/status",
    "/library/search?limit=20",
    "/spotify/library?type=playlists&limit=8",
    "/spotify/library?type=albums&limit=5",
    "/spotify/library?type=home&limit=5"
  ]);

  const health = await requestJson("/health");
  assert(health.ok === true, "health endpoint did not return ok=true");

  const state = await requestJson("/state");
  assert(state.player?.connected === true, "LMS player is not connected on public state");
  assert(state.services?.spotify?.configured === true, "Spotify/Spotty is not configured on public state");
  assert(Number(state.services?.localLibrary?.trackCount || 0) > 0, "public local library has no tracks");

  const search = await requestJson("/library/search?limit=5");
  assert(Array.isArray(search.results) && search.results.length > 0, "public library search returned no results");

  await assertMalformedJson();
  await assertQueueCrud();
  await assertSpotifyContainersOpenToTracks();
  await assertSpotifyLibrarySections();
  await assertLocalStream(search.results);
  await assertBatchQueueAndShuffle();
  await assertSmartShuffleSources();

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
  const batch = await requestJson("/player/tracks", {
    method: "POST",
    body: {
      action: "add-queue",
      tracks: [
        { title: "Smoke Verify One", artist: "CloudSqueeze", uri: "spotify:track:smokeone", source: "Spotify", kind: "track" },
        { title: "Smoke Verify Two", artist: "CloudSqueeze", uri: "spotify:track:smoketwo", source: "Spotify", kind: "track" }
      ]
    }
  });
  for (const item of batch.queued || []) createdQueueIds.push(item.id);
  assert(
    (batch.queued || []).map((item) => item.title).join("|") === "Smoke Verify One|Smoke Verify Two",
    "batch queue did not preserve order"
  );

  const playNext = await requestJson("/player/tracks", {
    method: "POST",
    body: {
      action: "play-next",
      tracks: [
        { title: "Smoke Verify Three", artist: "CloudSqueeze", uri: "spotify:track:smokethree", source: "Spotify", kind: "track" },
        { title: "Smoke Verify Four", artist: "CloudSqueeze", uri: "spotify:track:smokefour", source: "Spotify", kind: "track" },
        { title: "Smoke Verify Five", artist: "CloudSqueeze", uri: "spotify:track:smokefive", source: "Spotify", kind: "track" }
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
    body: { shuffle: true, smartQueue: false }
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

async function assertSmartShuffleSources() {
  const manual = await requestJson("/player/tracks", {
    method: "POST",
    body: {
      action: "add-queue",
      tracks: [
        { title: "Smoke Verify Manual Keeper", artist: "CloudSqueeze", uri: "spotify:track:smokekeeper", source: "Spotify", kind: "track" }
      ]
    }
  });
  for (const item of manual.queued || []) createdQueueIds.push(item.id);

  const spotify = await requestJson("/player/smart-shuffle", {
    method: "POST",
    body: { source: "spotify", count: 3, seed: "drake" }
  });
  const spotifyRows = (spotify.queued || []).filter((item) => item.requestedBy === "smart shuffle");
  assert(spotify.playback?.smartQueue === true, "spotify smart shuffle did not enable smart queue");
  assert(spotify.playback?.smartShuffleSource === "spotify", "spotify smart shuffle did not set spotify source");
  assert(spotifyRows.length > 0, "spotify smart shuffle did not queue generated rows");
  assert(spotifyRows.every((item) => String(item.uri || "").includes(":track:") && !item.path), "spotify smart shuffle queued non-Spotify tracks");

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
  const created = await requestJson("/queue", {
    method: "POST",
    body: { title, artist: "CloudSqueeze", source: "Smoke" }
  }, { expectedStatus: 201 });
  createdQueueIds.push(created.id);

  const duplicate = await requestJson("/queue", {
    method: "POST",
    body: { title, artist: "CloudSqueeze", source: "Smoke" }
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

async function assertSpotifyContainersOpenToTracks() {
  const library = await requestJson("/spotify/library?type=playlists&limit=8");
  const playlist = (library.results || []).find((item) => item.kind === "playlist" && (item.uri || item.browseId));
  assert(playlist, "Spotify playlist library did not expose a playlist container");

  const params = new URLSearchParams();
  if (playlist.browseId) params.set("browseId", String(playlist.browseId));
  if (playlist.uri) params.set("uri", String(playlist.uri));
  params.set("kind", "playlist");
  params.set("limit", "25");
  const children = await requestJson(`/spotify/children?${params.toString()}`);
  const tracks = (children.results || []).filter((item) => !item.kind || item.kind === "track");
  assert(tracks.length > 0, "Spotify playlist children did not expose playable tracks");
  assert(tracks.every((item) => String(item.uri || "").includes(":track:")), "Spotify playlist children included non-track items");
}

async function assertSpotifyLibrarySections() {
  const albums = await requestJson("/spotify/library?type=albums&limit=5");
  assert(Array.isArray(albums.results), "Spotify albums library did not return a results array");
  assert((albums.results || []).every((item) => item.kind === "album" && String(item.uri || "").includes(":album:")), "Spotify albums library returned non-album items");

  const home = await requestJson("/spotify/library?type=home&limit=5");
  assert(Array.isArray(home.results), "Spotify home library did not return a results array");
  assert((home.results || []).every((item) => item.kind !== "track" || String(item.uri || "").includes(":track:")), "Spotify home library returned malformed track items");
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

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
