import { describe, expect, it } from "vitest";
import {
  SyncCoordinator,
  computeClockMeasurement,
  validateCodedProbePair
} from "../server/syncCoordinator.js";

describe("sync coordinator", () => {
  it("computes NTP-style clock offset and RTT", () => {
    expect(computeClockMeasurement({ t0: 1000, t1: 1030, t2: 1035, t3: 1045 })).toEqual({
      clockOffsetMs: 10,
      rttMs: 40
    });
  });

  it("validates and rejects coded probe pairs by client/server gap drift", () => {
    expect(validateCodedProbePair({ t0: 1000, t1: 2000 }, { t0: 1025, t1: 2028 })).toMatchObject({
      ok: true,
      clientGapMs: 25,
      serverGapMs: 28,
      driftMs: 3
    });
    expect(validateCodedProbePair({ t0: 1000, t1: 2000 }, { t0: 1025, t1: 2050 })).toMatchObject({
      ok: false,
      driftMs: 25
    });
  });

  it("creates sessions and assigns host/guest roles", () => {
    const coordinator = new SyncCoordinator({ clock: () => 1000, idFactory: () => "session-1" });
    const host = coordinator.createOrJoinSession({
      shareToken: "house",
      device: { id: "host", label: "Kitchen" }
    });
    const guest = coordinator.createOrJoinSession({
      shareToken: "house",
      device: { id: "guest", label: "Phone" }
    });

    expect(host.device).toMatchObject({ id: "host", role: "host" });
    expect(guest.device).toMatchObject({ id: "guest", role: "guest" });
    expect(guest.session.hostId).toBe("host");
    expect(guest.session.devices.map((device: { role: string }) => device.role).sort()).toEqual(["guest", "host"]);
  });

  it("enforces host-only transport control", () => {
    const coordinator = new SyncCoordinator({ clock: () => 1000, idFactory: () => "session-1" });
    coordinator.createOrJoinSession({ shareToken: "house", device: { id: "host" } });
    coordinator.createOrJoinSession({ shareToken: "house", device: { id: "guest" } });

    expect(() =>
      coordinator.startLoad({
        shareToken: "house",
        deviceId: "guest",
        url: "/api/local-stream/track",
        trackOffsetMs: 0
      })
    ).toThrow(/host/i);
  });

  it("schedules after all clients are ready using max RTT plus max output latency headroom", () => {
    let now = 1000;
    const broadcasts: Array<{ shareToken: string; message: any }> = [];
    const coordinator = new SyncCoordinator({
      clock: () => now,
      idFactory: () => "session-1",
      broadcast: (shareToken, message) => broadcasts.push({ shareToken, message })
    });
    coordinator.createOrJoinSession({ shareToken: "house", device: { id: "host" } });
    coordinator.createOrJoinSession({ shareToken: "house", device: { id: "guest" } });
    coordinator.handleClockResponse({ shareToken: "house", deviceId: "host", rttMs: 80, outputLatencyMs: 30 });
    coordinator.handleClockResponse({ shareToken: "house", deviceId: "guest", rttMs: 120, outputLatencyMs: 70 });

    coordinator.startLoad({
      shareToken: "house",
      deviceId: "host",
      url: "/api/local-stream/abc",
      trackOffsetMs: 2500,
      track: { id: "spotify:track:abc", uri: "spotify:track:abc", source: "spotify", durationMs: 180000 }
    });
    expect(broadcasts.at(-1)?.message).toMatchObject({ type: "LOAD_AUDIO_SOURCE", trackOffsetMs: 2500 });

    expect(coordinator.markClientReady({ shareToken: "house", deviceId: "host" }).scheduled).toBe(false);
    const scheduled = coordinator.markClientReady({ shareToken: "house", deviceId: "guest" });

    expect(scheduled.scheduled).toBe(true);
    expect(scheduled.message).toMatchObject({
      type: "SCHEDULE_PLAY",
      url: "/api/local-stream/abc",
      startAtServerTime: 1190,
      trackOffsetMs: 2500
    });
    expect(coordinator.getSession("house")).toMatchObject({
      state: "playing",
      startAtServerTime: 1190,
      trackOffsetMs: 2500
    });
  });

  it("computes a late joiner's future playback offset", () => {
    let now = 1000;
    const unicasts: Array<{ deviceId: string; message: any }> = [];
    const coordinator = new SyncCoordinator({
      clock: () => now,
      idFactory: () => "session-1",
      unicast: (deviceId, message) => unicasts.push({ deviceId, message })
    });
    coordinator.createOrJoinSession({ shareToken: "house", device: { id: "host" } });
    coordinator.handleClockResponse({ shareToken: "house", deviceId: "host", rttMs: 100, outputLatencyMs: 0 });
    coordinator.startLoad({
      shareToken: "house",
      deviceId: "host",
      url: "/api/local-stream/abc",
      trackOffsetMs: 0,
      track: { id: "spotify:track:abc", uri: "spotify:track:abc", source: "spotify", durationMs: 120000 }
    });
    coordinator.markClientReady({ shareToken: "house", deviceId: "host" });
    expect(coordinator.getSession("house").startAtServerTime).toBe(1100);

    now = 5000;
    const joined = coordinator.createOrJoinSession({ shareToken: "house", device: { id: "late", rttMs: 50 } });

    expect(joined.lateJoin).toMatchObject({ deferred: false });
    expect(unicasts).toHaveLength(1);
    expect(unicasts[0]).toMatchObject({
      deviceId: "late",
      message: {
        type: "SCHEDULE_PLAY",
        startAtServerTime: 5100,
        trackOffsetMs: 4000
      }
    });
  });
});
