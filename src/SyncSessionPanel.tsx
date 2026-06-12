import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, Link2, Pause, Play, QrCode, Radio, Volume2 } from "lucide-react";
import { SyncEngine, type SyncEngineState } from "./lib/syncEngine";
import { localStreamUrl } from "./lib/localPlayer";
import type { Track } from "./types";

function initialToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("sync") || window.localStorage.getItem("cloud-squeeze-sync-token") || "";
}

function makeToken() {
  return crypto.randomUUID().slice(0, 8);
}

export function SyncSessionPanel({ nowPlaying }: { nowPlaying: Track }) {
  const [token, setToken] = useState(initialToken);
  const [activeToken, setActiveToken] = useState(initialToken);
  const [engineState, setEngineState] = useState<SyncEngineState | null>(null);
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const engine = useMemo(() => activeToken ? new SyncEngine({ shareToken: activeToken }) : null, [activeToken]);
  const streamUrl = localStreamUrl(nowPlaying);
  const isHost = engineState?.role === "host";
  const joined = Boolean(engineState?.joined);
  const shareUrl = activeToken ? `${window.location.origin}${window.location.pathname}?sync=${encodeURIComponent(activeToken)}` : "";

  useEffect(() => {
    if (!engine) return;
    const unsubscribe = engine.subscribe(setEngineState);
    engine.connect();
    (window as unknown as { __cloudSqueezeSync?: unknown }).__cloudSqueezeSync = engine;
    return () => {
      unsubscribe();
      engine.disconnect();
    };
  }, [engine]);

  function createSession() {
    const next = makeToken();
    setToken(next);
    setActiveToken(next);
    window.localStorage.setItem("cloud-squeeze-sync-token", next);
  }

  function joinSession() {
    const next = token.trim();
    if (!next) return;
    setActiveToken(next);
    window.localStorage.setItem("cloud-squeeze-sync-token", next);
  }

  async function copyLink() {
    if (!shareUrl) return;
    await navigator.clipboard?.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function playCurrent() {
    if (!engine || !streamUrl) return;
    engine.loadAudioSource(streamUrl, Math.max(0, Math.round((nowPlaying.elapsed || 0) * 1000)), {
      id: nowPlaying.id,
      uri: nowPlaying.uri || nowPlaying.id,
      source: nowPlaying.source,
      durationMs: Math.round((nowPlaying.duration || 0) * 1000),
      title: nowPlaying.title,
      artist: nowPlaying.artist
    });
  }

  return (
    <section
      className="sync-panel"
      aria-label="Sync session"
      data-sync-role={engineState?.role || ""}
      data-sync-connected={String(Boolean(engineState?.connected))}
      data-sync-joined={String(joined)}
      data-sync-unlocked={String(Boolean(engineState?.audioUnlocked))}
      data-sync-playing={String(Boolean(engineState?.playing))}
      data-sync-devices={String(engineState?.session?.devices?.length || 0)}
      data-sync-error={engineState?.error || ""}
    >
      <div className="sync-title">
        <Radio size={16} />
        <strong>Browser sync</strong>
      </div>
      <div className="sync-token-row">
        <input aria-label="Sync token" value={token} placeholder="Session token" onChange={(event) => setToken(event.target.value)} />
        <button type="button" onClick={joinSession} title="Join sync session"><Link2 size={16} /></button>
      </div>
      <div className="sync-actions">
        <button type="button" onClick={createSession}>Create</button>
        <button type="button" disabled={!shareUrl} onClick={copyLink}><Copy size={15} /> {copied ? "Copied" : "Copy"}</button>
        <button type="button" disabled={!shareUrl} onClick={() => setShowQr((value) => !value)} title="Show QR code" aria-pressed={showQr}><QrCode size={15} /></button>
      </div>
      {showQr && shareUrl && (
        <div className="sync-qr">
          <QRCodeSVG value={shareUrl} size={156} bgColor="#ffffff" fgColor="#0b0f17" marginSize={2} />
          <small>Scan to join on a phone</small>
        </div>
      )}
      {engine && (
        <button className="sync-unlock" type="button" disabled={engineState?.audioUnlocked} onClick={() => engine.unlockAudio()}>
          {engineState?.audioUnlocked ? "Audio joined" : "Tap to join audio"}
        </button>
      )}
      {joined && (
        <>
          <div className="sync-status">
            <span>{engineState?.connected ? "Connected" : "Reconnecting"}</span>
            <span>{engineState?.role}</span>
            <span>{Math.round(engineState?.rttMs || 0)}ms RTT</span>
          </div>
          {engineState?.loading && (
            <div className="sync-buffering">Buffering audio… first play of a track can take a few seconds.</div>
          )}
          {!engineState?.loading && engineState?.awaitingStart && !engineState?.playing && (
            <div className="sync-buffering">Ready — waiting for the group to buffer so everyone starts together…</div>
          )}
          {!engineState?.loading && engineState?.playing && (
            <div className="sync-buffering sync-live">▶ Playing in sync</div>
          )}
          {isHost ? (
            <div className="sync-transport">
              <button type="button" disabled={!streamUrl || !engineState?.audioUnlocked} onClick={playCurrent}><Play size={15} /> Current</button>
              <button type="button" onClick={() => engine?.pause()}><Pause size={15} /> Pause</button>
            </div>
          ) : (
            <small>Guests add requests through the queue; transport is host-only.</small>
          )}
          <div className="sync-devices">
            {(engineState?.session?.devices || []).map((device) => (
              <div className="sync-device" key={device.id}>
                <div>
                  <strong>{device.label}</strong>
                  <small>{device.role} · {Math.round(device.rttMs || 0)}ms</small>
                </div>
                <label>
                  <Volume2 size={14} />
                  <input
                    aria-label={`${device.label} volume`}
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={device.volume}
                    onChange={(event) => engine?.setVolume(device.id, Number(event.target.value))}
                  />
                </label>
                <input
                  aria-label={`${device.label} nudge`}
                  type="range"
                  min="-200"
                  max="200"
                  step="10"
                  value={device.nudgeMs}
                  onChange={(event) => engine?.nudge(device.id, Number(event.target.value) - device.nudgeMs)}
                />
              </div>
            ))}
          </div>
        </>
      )}
      {engineState?.error && <small className="sync-error">{engineState.error}</small>}
    </section>
  );
}
