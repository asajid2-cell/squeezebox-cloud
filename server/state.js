export const config = {
  port: Number(process.env.PORT || 4177),
  lmsHost: process.env.LMS_HOST || "127.0.0.1",
  lmsCliPort: Number(process.env.LMS_CLI_PORT || 9090),
  lmsHttpUrl: process.env.LMS_HTTP_URL || "http://127.0.0.1:9000",
  lmsConfigDir: expandPath(process.env.LMS_CONFIG_DIR || "/config"),
  lanLmsHost: process.env.LAN_LMS_HOST || "192.168.1.142",
  publicLmsHost: process.env.PUBLIC_LMS_HOST || "23.17.17.81",
  publicLmsHttpUrl: process.env.PUBLIC_LMS_HTTP_URL || "http://23.17.17.81:9000",
  musicSourceDir: expandPath(process.env.MUSIC_SOURCE_DIR || "%USERPROFILE%\\Downloads"),
  uploadDir: expandPath(process.env.UPLOAD_DIR || "/music/uploads"),
  publicQueueMaxPerUser: Number(process.env.PUBLIC_QUEUE_MAX_PER_USER || 3)
};

export const appState = {
  player: {
    id: "mock-player",
    name: "Squeezebox Cloud Room",
    connected: false,
    online: false,
    mode: "stopped",
    volume: 68,
    updatedAt: new Date().toISOString()
  },
  nowPlaying: {
    id: "idle",
    title: "No track playing",
    artist: "Connect a player or request a song",
    album: "",
    source: "LMS",
    duration: 0,
    elapsed: 0,
    canSeek: false,
    art: null
  },
  queue: [],
  recentPicks: [],
  schedule: {
    current: { name: "Open Queue", until: "10:00 PM", requestsPaused: false },
    next: { name: "Quiet Hours", time: "10:00 PM - 8:00 AM", requestsPaused: true }
  },
  rules: [
    { title: "Be respectful", detail: "No hate speech or harassment" },
    { title: "No spam", detail: "Do not add duplicates or floods" },
    { title: "Keep it clean", detail: "No explicit or offensive content" },
    { title: "Max 3 in queue", detail: "Per person at a time" }
  ],
  services: {
    spotify: { configured: false, reachable: false, detail: "Not checked yet" },
    localLibrary: { root: config.musicSourceDir, reachable: false, trackCount: 0, uploadedCount: 0 },
    musicInfo: {
      configured: false,
      reachable: false,
      detail: "Enable the Music and Artist Information plugin in LMS for artist bios, album notes, and lyrics."
    }
  },
  trackInfo: {
    artistBio: "Connect a Squeezebox player, start a track, then enable the LMS Music and Artist Information plugin for live biographies, album reviews, and lyrics.",
    albumReview: "No album review is available until a real track is playing.",
    lyrics: "Lyrics will appear here when the LMS plugin exposes them."
  },
  playback: {
    shuffle: false,
    smartQueue: false,
    repeat: "off",
    smartShuffleSource: "mixed",
    lastShuffleRefillAt: 0,
    lastShuffleSeed: "",
    lastSmartQueueBase: "",
    history: []
  },
  admin: {
    publicRequests: true,
    maxQueuePerUser: config.publicQueueMaxPerUser,
    moderation: "basic",
    scheduleEnabled: true
  }
};

let queueIdCounter = 0;

export function getPublicState() {
  return structuredClone(appState);
}

export function addQueueItem(input) {
  const item = {
    id: nextQueueId(),
    title: input.title,
    artist: input.artist || "Unknown artist",
    album: input.album,
    source: input.source || "Local library",
    path: input.path,
    uri: input.uri,
    art: input.art,
    kind: input.kind,
    uploaded: input.uploaded,
    lmsTrackId: input.lmsTrackId,
    requestedBy: input.requestedBy || "guest",
    etaMinutes: nextEta()
  };
  appState.queue.push(item);
  appState.recentPicks.unshift({ title: item.title, artist: item.artist, status: "Queued" });
  appState.recentPicks = appState.recentPicks.slice(0, 8);
  return item;
}

export function addQueueItemNext(input) {
  const item = {
    id: nextQueueId(),
    title: input.title,
    artist: input.artist || "Unknown artist",
    album: input.album,
    source: input.source || "Local library",
    path: input.path,
    uri: input.uri,
    art: input.art,
    kind: input.kind,
    uploaded: input.uploaded,
    lmsTrackId: input.lmsTrackId,
    requestedBy: input.requestedBy || "guest",
    etaMinutes: 7
  };
  appState.queue.unshift(item);
  appState.recentPicks.unshift({ title: item.title, artist: item.artist, status: "Play next" });
  appState.recentPicks = appState.recentPicks.slice(0, 8);
  recalculateQueueEtas();
  return item;
}

export function updateQueueItem(id, input) {
  const index = appState.queue.findIndex((item) => item.id === id);
  if (index < 0) return null;
  appState.queue[index] = {
    ...appState.queue[index],
    ...["title", "artist", "album", "requestedBy"].reduce((updates, key) => {
      if (typeof input[key] === "string" && input[key].trim()) updates[key] = input[key].trim();
      return updates;
    }, {})
  };
  return appState.queue[index];
}

export function removeQueueItem(id) {
  const index = appState.queue.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const [removed] = appState.queue.splice(index, 1);
  recalculateQueueEtas();
  return removed;
}

export function moveQueueItem(id, direction) {
  const index = appState.queue.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const target = direction === "up" ? index - 1 : direction === "down" ? index + 1 : Number(direction);
  if ((direction === "up" && index === 0) || (direction === "down" && index === appState.queue.length - 1)) return appState.queue[index];
  if (!Number.isInteger(target) || target < 0 || target >= appState.queue.length) return undefined;
  const [item] = appState.queue.splice(index, 1);
  appState.queue.splice(target, 0, item);
  recalculateQueueEtas();
  return item;
}

export function setVolume(volume) {
  appState.player.volume = Math.max(0, Math.min(100, Number(volume)));
  appState.player.updatedAt = new Date().toISOString();
  return appState.player.volume;
}

export function setMode(mode) {
  appState.player.mode = mode;
  appState.player.updatedAt = new Date().toISOString();
  return appState.player.mode;
}

export function updatePlayback(settings) {
  appState.playback = { ...appState.playback, ...settings };
  return appState.playback;
}

export function updatePlayerStatus(status) {
  appState.player = { ...appState.player, ...status, updatedAt: new Date().toISOString() };
}

export function updateNowPlaying(track) {
  if (track) {
    appState.nowPlaying = { ...appState.nowPlaying, ...track };
  }
}

export function updateLibraryStatus(status) {
  appState.services.localLibrary = { ...appState.services.localLibrary, ...status };
}

export function updateSpotifyStatus(status) {
  appState.services.spotify = { ...appState.services.spotify, ...status };
}

export function updateMusicInfoStatus(status) {
  appState.services.musicInfo = { ...appState.services.musicInfo, ...status };
}

export function updateTrackInfo(info) {
  appState.trackInfo = { ...appState.trackInfo, ...info };
}

function nextEta() {
  const last = appState.queue.at(-1);
  return (last?.etaMinutes || 0) + 7;
}

function recalculateQueueEtas() {
  appState.queue.forEach((item, index) => {
    item.etaMinutes = (index + 1) * 7;
  });
}

function nextQueueId() {
  queueIdCounter += 1;
  return `q-${Date.now()}-${queueIdCounter}`;
}

function expandPath(value) {
  return value
    .replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || "")
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || "")
    .replace(/\$HOME/g, process.env.HOME || process.env.USERPROFILE || "");
}
