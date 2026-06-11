import { describe, expect, it } from "vitest";
import {
  computeClockMeasurement,
  computeScheduleWaitSeconds,
  filterOutputLatencyMs,
  selectMinRttMeasurement
} from "../src/lib/syncEngine";

describe("sync engine timing math", () => {
  it("computes clock offset and RTT from four timestamps", () => {
    expect(computeClockMeasurement({ t0: 1000, t1: 1030, t2: 1035, t3: 1045 })).toEqual({
      clockOffsetMs: 10,
      rttMs: 40
    });
  });

  it("selects the minimum-RTT measurement for offset", () => {
    expect(selectMinRttMeasurement([
      { clockOffsetMs: 18, rttMs: 90 },
      { clockOffsetMs: 11, rttMs: 32 },
      { clockOffsetMs: 15, rttMs: 48 }
    ])).toEqual({ clockOffsetMs: 11, rttMs: 32 });
  });

  it("filters untrustworthy Bluetooth-sized output latency", () => {
    expect(filterOutputLatencyMs(24)).toBe(24);
    expect(filterOutputLatencyMs(648)).toBe(0);
  });

  it("clamps after subtracting output latency and applies nudge to effective offset", () => {
    expect(computeScheduleWaitSeconds({
      startAtServerTime: 1120,
      epochNowMs: 1000,
      clockOffsetMs: 10,
      outputLatencyMs: 30
    })).toBe(0.08);

    expect(computeScheduleWaitSeconds({
      startAtServerTime: 1020,
      epochNowMs: 1000,
      clockOffsetMs: 10,
      outputLatencyMs: 30
    })).toBe(0);

    expect(computeScheduleWaitSeconds({
      startAtServerTime: 1120,
      epochNowMs: 1000,
      clockOffsetMs: 10,
      outputLatencyMs: 30,
      nudgeMs: 20
    })).toBe(0.06);
  });
});
