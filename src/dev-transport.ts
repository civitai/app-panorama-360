// Test/dev-only transport wiring — NOT imported by production code.
//
// The SDK's IframeTransport is a process-wide singleton whose FIRST
// getTransport() call decides the origin allowlist, and it DROPS inbound
// messages from non-allowlisted origins. The mock/live hosts reply from
// `window.location.origin`, so that origin must be allowed BEFORE any hook or
// host runs.

import { getTransport } from '@civitai/blocks-react';
import { resetTransport } from '@civitai/blocks-react/testing';
// `createLiveHost` moved OFF `/testing` in blocks-react 0.55.0 and onto its own
// subpath: `/testing` is now all-mock by construction, so the one export that
// spends the token holder's real Buzz cannot sit one autocomplete entry away
// from `createMockHost`. Same function, same options — only the path changed.
import { createLiveHost } from '@civitai/blocks-react/live';

/**
 * `'mock'` — SDK mock host, no network, no Buzz. `'orch'` — mock host with the
 * workflow messages answered by real orchestrator calls (orch-host.ts, spends
 * real Buzz). `'live'` — real host + real block token, fails safe without one.
 */
export type HarnessMode = 'mock' | 'live' | 'orch';

export function getHarnessMode(): HarnessMode {
  const raw = import.meta.env.VITE_HARNESS_MODE;
  if (raw === 'live') return 'live';
  if (raw === 'orch') return 'orch';
  return 'mock';
}

/** Call once before rendering; the singleton's first caller wins. */
export function installHarnessTransport() {
  getTransport({ allowedParentOrigins: [window.location.origin] });
}

/** For `beforeEach` — without the reset, one test's singleton leaks into the next. */
export function resetHarnessTransport() {
  resetTransport();
  getTransport({ allowedParentOrigins: [window.location.origin] });
}

export type LiveConfig =
  | { ready: false; reason: string }
  | { ready: true; token: string; backendBaseUrl: string };

/**
 * Fail-safe by design: live mode spends REAL Buzz, so it refuses to mount
 * without a dev block token (`VITE_LIVE_BLOCK_TOKEN` — minted by the invite-
 * gated dev-token endpoint; never commit it).
 */
export function resolveLiveConfig(): LiveConfig {
  const token = import.meta.env.VITE_LIVE_BLOCK_TOKEN as string | undefined;
  // Empty base = fetch `/api/...` against THIS dev server; the vite proxy
  // rewrites Origin toward civitai, which avoids CORS preflight AND satisfies
  // the tRPC origin gate — direct cross-origin fetches fail both.
  const backendBaseUrl = '';

  if (!token) {
    return {
      ready: false,
      reason: 'Set one up below to run against your own account.',
    };
  }
  return { ready: true, token, backendBaseUrl };
}

/** Mounts the SDK live host for `dev:live`; returns the uninstall teardown. */
export function installLiveHost(config: { token: string; backendBaseUrl: string }): () => void {
  installHarnessTransport();
  const host = createLiveHost({
    blockToken: config.token,
    backendBaseUrl: config.backendBaseUrl,
    // Must be a BOUND fetch: a detached `globalThis.fetch` reference throws
    // "Illegal invocation" in the browser, breaking the picker's catalog load.
    fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  });
  return host.install();
}
