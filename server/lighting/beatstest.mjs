// Dev harness: prove beats.js fetches a real grid from the harmonizer + caches it.
// Non-intrusive (does NOT push to the strip). Run in the cloud-squeeze container.
import { requestBeats } from "./beats.js";

const track = { title: "Janice STFU", artist: "Drake", uri: "spotify:track:514joG57v4yKTsfQmz7stz", id: "514joG57v4yKTsfQmz7stz" };
console.log("requesting beat grid for", track.artist, "-", track.title, "...");
requestBeats(track, (grid) => {
  console.log("GRID  tempo:", grid.tempo, " beats:", grid.beats.length, " sections:", grid.sections.length);
  console.log("first beats(ms):", grid.beats.slice(0, 8));
  setTimeout(() => process.exit(0), 800);   // let the cache persist
});
setTimeout(() => { console.log("TIMEOUT - no grid"); process.exit(1); }, 120000);
