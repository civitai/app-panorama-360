// Live "buzz spent so far" for post-paid steps. Pure math, no timers — the
// caller ticks it. Pin the rate from the first `output.usage` seen,
// extrapolate `ceil(rate × elapsed)` between polls, never display less than
// the last server estimate, snap to the settled total at terminal.
//
// Anchoring: every source estimates the SAME instant (billing-clock start)
// and every lag pushes an estimate LATER — mid-run `usage.startedAt` is
// derived from heartbeat-lagged runtime, so re-anchoring each poll would
// saw-tooth the counter. The anchor is therefore the EARLIEST evidence ever
// seen and never moves forward; the trace's first execution frame lands
// within ~100ms of the true start and usually wins.

import type { BuzzMeterState, UsageInfo } from './types.js';

export interface BuzzMeter {
  observeUsage(usage: UsageInfo): void;
  /** The worker's ComfyUI execution started (trace evidence, server-clock ms). */
  markComputeStart(serverTsMs: number): void;
  /** Extrapolated buzz at local time `nowMs` (settled total once settled). */
  tick(nowMs: number): number | null;
  settle(total: number | null | undefined): void;
  state(nowMs: number): BuzzMeterState;
}

export function createBuzzMeter(): BuzzMeter {
  let rate: number | null = null;
  /** Local ms corresponding to the moment billing started. */
  let anchorLocalMs: number | null = null;
  /** localNow - serverNow, learned from usage.computedAt samples. */
  let clockOffsetMs = 0;
  let serverFloor = 0;
  let settledTotal: number | null = null;
  let settled = false;

  const proposeAnchor = (ms: number) => {
    anchorLocalMs = anchorLocalMs === null ? ms : Math.min(anchorLocalMs, ms);
  };

  return {
    observeUsage(usage) {
      if (settled) return;
      if (typeof usage.estimatedCost === 'number') {
        serverFloor = Math.max(serverFloor, usage.estimatedCost);
      }
      if (rate === null && typeof usage.buzzPerSecond === 'number' && usage.buzzPerSecond > 0) {
        rate = usage.buzzPerSecond;
      }
      const localNow = Date.now();
      const computedAt = usage.computedAt ? Date.parse(usage.computedAt) : NaN;
      const startedAt = usage.startedAt ? Date.parse(usage.startedAt) : NaN;
      if (Number.isFinite(computedAt)) clockOffsetMs = localNow - computedAt;
      if (Number.isFinite(startedAt)) {
        proposeAnchor(
          Number.isFinite(computedAt)
            ? localNow - (computedAt - startedAt)
            : startedAt + clockOffsetMs,
        );
      } else if (typeof usage.runtimeSeconds === 'number' && usage.runtimeSeconds > 0) {
        proposeAnchor(localNow - usage.runtimeSeconds * 1000);
      }
    },

    markComputeStart(serverTsMs) {
      if (settled) return;
      proposeAnchor(serverTsMs + clockOffsetMs);
    },

    tick(nowMs) {
      if (settled) return settledTotal;
      if (anchorLocalMs === null || rate === null) {
        if (serverFloor > 0) return serverFloor;
        return rate !== null ? 0 : null;
      }
      const elapsedSeconds = Math.max(0, (nowMs - anchorLocalMs) / 1000);
      return Math.max(serverFloor, Math.ceil(rate * elapsedSeconds));
    },

    settle(total) {
      settled = true;
      settledTotal = typeof total === 'number' ? total : serverFloor > 0 ? serverFloor : null;
    },

    state(nowMs) {
      return { live: this.tick(nowMs), rate, settled };
    },
  };
}
