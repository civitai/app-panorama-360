import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBuzzMeter } from './buzz-meter.js';

const T0 = Date.parse('2026-07-17T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('createBuzzMeter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports null before any usage, and the server floor before a rate', () => {
    const meter = createBuzzMeter();
    expect(meter.tick(T0)).toBeNull();
    meter.observeUsage({ estimatedCost: 7 });
    expect(meter.tick(T0)).toBe(7);
    expect(meter.state(T0)).toEqual({ live: 7, rate: null, settled: false });
  });

  it('pins the rate from the first usage and extrapolates ceil(rate x elapsed)', () => {
    const meter = createBuzzMeter();
    // Server: started 10s before it computed; computed "now" (clocks aligned).
    meter.observeUsage({
      buzzPerSecond: 1,
      estimatedCost: 10,
      runtimeSeconds: 10,
      startedAt: iso(T0 - 10_000),
      computedAt: iso(T0),
    });
    expect(meter.tick(T0)).toBe(10);
    expect(meter.tick(T0 + 5_000)).toBe(15);
    expect(meter.state(T0 + 5_000).rate).toBe(1);
  });

  it('aligns to the server clock via computedAt (server 30s ahead of local)', () => {
    const meter = createBuzzMeter();
    meter.observeUsage({
      buzzPerSecond: 2,
      startedAt: iso(T0 + 20_000),
      computedAt: iso(T0 + 30_000), // server elapsed = 10s regardless of skew
    });
    expect(meter.tick(T0)).toBe(20);
  });

  it('never displays less than the last server-reported estimate', () => {
    const meter = createBuzzMeter();
    meter.observeUsage({
      buzzPerSecond: 1,
      estimatedCost: 40,
      startedAt: iso(T0 - 5_000),
      computedAt: iso(T0),
    });
    expect(meter.tick(T0)).toBe(40);
    meter.observeUsage({ buzzPerSecond: 1, estimatedCost: 44 });
    expect(meter.tick(T0 + 1_000)).toBe(44);
  });

  it('does not re-pin the rate on later samples', () => {
    const meter = createBuzzMeter();
    meter.observeUsage({ buzzPerSecond: 1, startedAt: iso(T0 - 10_000), computedAt: iso(T0) });
    meter.observeUsage({ buzzPerSecond: 99, startedAt: iso(T0), computedAt: iso(T0) });
    expect(meter.state(T0).rate).toBe(1);
  });

  it('falls back to runtimeSeconds anchoring when timestamps are missing', () => {
    const meter = createBuzzMeter();
    meter.observeUsage({ buzzPerSecond: 1, runtimeSeconds: 12 });
    expect(meter.tick(T0)).toBe(12);
  });

  it('does NOT wall-extrapolate before billing starts (pre-compute usage block)', () => {
    const meter = createBuzzMeter();
    // What the orchestrator reports while models still download: rate pinned,
    // zero runtime, no startedAt.
    meter.observeUsage({ buzzPerSecond: 1, runtimeSeconds: 0, estimatedCost: 0, computedAt: iso(T0) });
    expect(meter.tick(T0 + 30_000)).toBe(0);
    // Billing starts: startedAt appears and re-anchors to the server truth.
    vi.setSystemTime(T0 + 30_000);
    meter.observeUsage({
      buzzPerSecond: 1,
      runtimeSeconds: 5,
      estimatedCost: 5,
      startedAt: iso(T0 + 25_000),
      computedAt: iso(T0 + 30_000),
    });
    meter.observeUsage({ buzzPerSecond: 1 }); // no-op sample must not move the anchor
    expect(meter.tick(T0 + 30_000)).toBe(5);
    expect(meter.tick(T0 + 40_000)).toBe(15);
  });

  it('anchors on the EARLIEST evidence — later estimates never move it forward', () => {
    const meter = createBuzzMeter();
    // Pre-compute poll: rate known, clock offset learned, no anchor yet.
    meter.observeUsage({ buzzPerSecond: 1, runtimeSeconds: 0, computedAt: iso(T0) });
    meter.markComputeStart(T0 + 10_000);
    expect(meter.tick(T0 + 20_000)).toBe(10);
    // A laggy runtime-only sample (would imply "started 2s ago") is later — ignored.
    vi.setSystemTime(T0 + 30_000);
    meter.observeUsage({ buzzPerSecond: 1, runtimeSeconds: 2 });
    expect(meter.tick(T0 + 30_000)).toBe(20);
    // A derived server startedAt LATER than the trace anchor is ignored too…
    meter.observeUsage({
      buzzPerSecond: 1,
      startedAt: iso(T0 + 12_000),
      computedAt: iso(T0 + 30_000),
    });
    expect(meter.tick(T0 + 30_000)).toBe(20);
    // …but an EARLIER one wins.
    meter.observeUsage({
      buzzPerSecond: 1,
      startedAt: iso(T0 + 8_000),
      computedAt: iso(T0 + 30_000),
    });
    expect(meter.tick(T0 + 30_000)).toBe(22);
  });

  it('regression: laggy per-poll usage cannot saw-tooth the counter back down', () => {
    const meter = createBuzzMeter();
    // Each poll derives startedAt = computedAt - laggedRuntime ("started 1s ago").
    for (let poll = 1; poll <= 4; poll++) {
      const at = T0 + poll * 8_000;
      vi.setSystemTime(at);
      meter.observeUsage({
        buzzPerSecond: 1,
        runtimeSeconds: 1,
        estimatedCost: 1,
        startedAt: iso(at - 1_000),
        computedAt: iso(at),
      });
    }
    // Anchor stayed at the FIRST (earliest) estimate: T0 + 7s.
    expect(meter.tick(T0 + 32_000)).toBe(25);
    let last = 0;
    for (let t = T0 + 8_000; t <= T0 + 40_000; t += 1_000) {
      const live = meter.tick(t) ?? 0;
      expect(live).toBeGreaterThanOrEqual(last);
      last = live;
    }
  });

  it('settles: snaps to the total and ignores later usage', () => {
    const meter = createBuzzMeter();
    meter.observeUsage({ buzzPerSecond: 1, startedAt: iso(T0 - 10_000), computedAt: iso(T0) });
    meter.settle(45);
    expect(meter.tick(T0 + 60_000)).toBe(45);
    meter.observeUsage({ estimatedCost: 99 });
    expect(meter.tick(T0 + 60_000)).toBe(45);
    expect(meter.state(T0).settled).toBe(true);
  });

  it('settle(undefined) falls back to the last server estimate', () => {
    const meter = createBuzzMeter();
    meter.observeUsage({ estimatedCost: 13 });
    meter.settle(undefined);
    expect(meter.tick(T0)).toBe(13);
    const empty = createBuzzMeter();
    empty.settle(undefined);
    expect(empty.tick(T0)).toBeNull();
  });
});
