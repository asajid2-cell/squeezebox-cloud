import { scanLibrary } from "../server/library.js";
import { config } from "../server/state.js";

const tracks = await scanLibrary(config.musicSourceDir, 25);
console.log(`Library smoke: ${tracks.length} tracks sampled from ${config.musicSourceDir}`);
if (tracks.length === 0) {
  console.error("No audio files found. Check MUSIC_SOURCE_DIR or put test songs in Downloads.");
  process.exit(1);
}
console.log(tracks.slice(0, 5).map((track) => `- ${track.title} (${track.source})`).join("\n"));

