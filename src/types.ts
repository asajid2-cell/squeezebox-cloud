export type Track = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  source: string;
  uploaded?: boolean;
  kind?: "track" | "artist" | "album" | "playlist";
  duration?: number | null;
  elapsed?: number;
  canSeek?: boolean;
  art?: string | null;
  artwork?: string | null;
  path?: string;
  uri?: string;
  lmsTrackId?: string | number;
  browseId?: string;
  collection?: string;
  folder?: string;
};

export type QueueItem = Track & {
  requestedBy: string;
  etaMinutes: number;
};

export type CurationItem = {
  key: string;
  track: Partial<Track>;
  updatedAt: string;
};

export type AppState = {
  player: {
    id: string;
    name: string;
    connected: boolean;
    online: boolean;
    mode: string;
    volume: number;
    detail?: string;
  };
  nowPlaying: Track;
  queue: QueueItem[];
  recentPicks: Array<{ id?: string; title: string; artist: string; status: string }>;
  schedule: {
    current: { name: string; until: string; requestsPaused: boolean };
    next: { name: string; time: string; requestsPaused: boolean };
  };
  rules: Array<{ title: string; detail: string }>;
  services: {
    spotify: { configured: boolean; reachable: boolean; detail: string };
    localLibrary: { root: string; reachable: boolean; trackCount: number; uploadedCount?: number; error?: string };
    musicInfo: { configured: boolean; reachable: boolean; detail: string };
  };
  trackInfo: {
    artistBio: string;
    albumReview: string;
    lyrics: string;
    art?: string | null;
  };
  playback: {
    shuffle: boolean;
    manualShuffle?: boolean;
    smartQueue?: boolean;
    repeat: "off" | "one" | "all";
    smartShuffleSource: "mixed" | "spotify" | "local";
    lastShuffleRefillAt?: number;
    lastShuffleSeed?: string;
    lastSmartQueueBase?: string;
    history?: string[];
    previousTracks?: Partial<Track>[];
  };
  curation: {
    hidden: CurationItem[];
    saved: CurationItem[];
    pinned: CurationItem[];
    revision: number;
  };
  admin: {
    publicRequests: boolean;
    maxQueuePerUser: number;
    moderation: string;
    scheduleEnabled: boolean;
  };
};

export type ConnectionGuide = {
  serverHost: string;
  lanServerHost?: string;
  lmsWebUrl: string;
  ports: Array<{ port: number; label: string }>;
  lmsWeb: { reachable: boolean; status: number; url: string; detail?: string };
  player: AppState["player"];
  steps: string[];
};

export type LibraryCollection = {
  collection: string;
  folder: string;
  count: number;
  sample: string[];
  art?: string | null;
};

export type SpotifySearchGroups = {
  tracks: Track[];
  artists: Track[];
  albums: Track[];
  playlists: Track[];
};

export type PlaylistSummary = {
  id: string;
  name: string;
  description: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  trackCount: number;
  art?: string | null;
  sample: string[];
};

export type Playlist = PlaylistSummary & {
  tracks: Track[];
};
