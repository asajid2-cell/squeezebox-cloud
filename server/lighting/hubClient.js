// Talks to the device-hub (the broker that owns the room phone). The phone runs
// the BLE strip; we just push high-level commands and let it execute locally.
// Fire-and-forget with a timeout + soft-fail, like screenClient.js — lighting must
// never block or break playback.

const HUB_URL = (process.env.HUB_URL || "http://127.0.0.1:4196").replace(/\/$/, "");
const HUB_TOKEN = process.env.HUB_TOKEN || "";

async function cmd(name, args = {}, timeoutMs = 8000) {
  try {
    const res = await fetch(`${HUB_URL}/device/cmd`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(HUB_TOKEN ? { "x-hub-token": HUB_TOKEN } : {}) },
      body: JSON.stringify({ name, args, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 2000)
    });
    return await res.json();
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

export function pushScene(spec, timeoutMs = 20000) {
  // First connect can take ~20s; everything after is instant.
  return cmd("led.scene", spec, timeoutMs);
}

export function ledColor(hex, timeoutMs = 12000) {
  return cmd("led.color", { hex }, timeoutMs);
}

export function ledOff() {
  return cmd("led.off", {});
}

export function ledStop() {
  return cmd("led.stop", {});
}

export async function deviceOnline() {
  try {
    const res = await fetch(`${HUB_URL}/device/status`, {
      headers: HUB_TOKEN ? { "x-hub-token": HUB_TOKEN } : {},
      signal: AbortSignal.timeout(4000)
    });
    const j = await res.json();
    return !!j.online;
  } catch {
    return false;
  }
}

export const hub = { cmd, pushScene, ledColor, ledOff, ledStop, deviceOnline };
