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
    "/spotify/library?type=playlists&limit=8"
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
  await assertBatchQueueAndShuffle();

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

async function requestJson(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  assert(response.ok, `${path} returned HTTP ${response.status}: ${text.slice(0, 160)}`);
  return data;
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
