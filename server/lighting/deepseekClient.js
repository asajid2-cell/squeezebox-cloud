// DeepSeek designs a full lighting ROUTINE for a song — not just colors, but the
// mode (drift/breathe/pulse/scene), palette, tempo, speed, energy and brightness
// that the phone's scene engine executes. Text-only model, JSON mode.

const API_KEY = process.env.DEEPSEEK_API_KEY || "";
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

const SYSTEM = `You are a lighting director for ONE RGB LED strip in a bedroom. You design a
looping routine that matches a song's mood, genre, energy and era. The controller runs
the animation LOCALLY given your spec, so choose the mode + parameters deliberately.

Modes (pick ONE):
- "drift"  : slowly, smoothly cycles through the palette. Calm, ambient, atmospheric songs.
- "breathe": one base color, brightness swells in/out like breathing. Slow/intimate songs.
- "pulse"  : color slowly drifts while BRIGHTNESS spikes on every beat (beat-synced).
             Use for rhythmic / energetic / hip-hop / trap / EDM / dance songs. Needs bpm.
- "scene"  : palette steps through colors by song section. Dynamic, multi-part songs.

Output ONLY a JSON object:
{
  "mode": "drift|breathe|pulse|scene",
  "palette": ["rrggbb", ...],   // 3-6 hex colors (NO '#') capturing the song's vibe + cover
  "bpm": <int>,                 // tempo estimate (drives pulse/breathe timing); 0 if unsure
  "speed": <0..1>,              // animation/color-drift speed
  "energy": <0..1>,             // intensity: pulse peak height + how punchy it feels
  "brightness": <0..255>,       // base brightness
  "rationale": "<one sentence: the mood you're evoking>"
}

Design with intent: dark/moody/aggressive -> deep desaturated palette, lower brightness,
punchy pulse; euphoric -> brighter warm tones; melancholic -> cool dim breathe; club/EDM
-> saturated pulse at the real bpm. Anchor the palette in the album-cover colors when given,
but shift them toward the emotional tone. Avoid muddy all-gray palettes; keep 1-2 accents.`;

const HEX = /^[0-9a-fA-F]{6}$/;

function sanitize(spec) {
  const modes = new Set(["drift", "breathe", "pulse", "scene", "solid"]);
  const mode = modes.has(String(spec.mode)) ? String(spec.mode) : "drift";
  let palette = Array.isArray(spec.palette)
    ? spec.palette.map((c) => String(c).replace(/^#/, "").toLowerCase()).filter((c) => HEX.test(c))
    : [];
  if (palette.length === 0) palette = ["ff8800", "ffd1a0", "ff5500"];
  palette = palette.slice(0, 6);
  const clamp = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  return {
    mode,
    palette,
    bpm: Math.round(clamp(spec.bpm, 0, 300, 0)),
    speed: clamp(spec.speed, 0, 1, 0.5),
    energy: clamp(spec.energy, 0, 1, 0.5),
    brightness: Math.round(clamp(spec.brightness, 8, 255, 200)),
    rationale: typeof spec.rationale === "string" ? spec.rationale.slice(0, 200) : ""
  };
}

/** Ask DeepSeek to design a routine for a track. Returns a sanitized spec or null. */
export async function designRoutine(track, paletteHint = []) {
  if (!API_KEY) return null;
  let user = `Song: "${track.title || ""}" by ${track.artist || ""}`;
  if (track.album) user += `, album "${track.album}"`;
  if (track.year) user += ` (${track.year})`;
  user += ".";
  if (paletteHint && paletteHint.length) user += ` Album-cover dominant colors (hex): ${paletteHint.join(", ")}.`;
  user += " Design the looping lighting routine now. JSON only.";

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
        response_format: { type: "json_object" },
        temperature: 0.8
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return null;
    const j = await res.json();
    const content = j?.choices?.[0]?.message?.content;
    if (!content) return null;
    return sanitize(JSON.parse(content));
  } catch {
    return null;
  }
}

export const deepseekConfigured = () => !!API_KEY;
