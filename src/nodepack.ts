// Install-layer AIR cache — an optimization only: the layer goes stale when
// the worker image rolls over, so callers invalidate + retry 2-step on
// failure. localStorage THROWS in the production block sandbox (no
// allow-same-origin), hence the guarded in-memory fallback.

import { NODEPACK_AIR } from './panorama.js';

const KEY = `pano360.layerAir.v1:${NODEPACK_AIR}`;

let memoryFallback: string | undefined;

export function getCachedLayerAir(): string | undefined {
  try {
    return window.localStorage.getItem(KEY) ?? memoryFallback;
  } catch {
    return memoryFallback;
  }
}

export function setCachedLayerAir(layerAir: string): void {
  memoryFallback = layerAir;
  try {
    window.localStorage.setItem(KEY, layerAir);
  } catch {
    /* sandboxed / storage-disabled — memory fallback covers the session */
  }
}

export function clearCachedLayerAir(): void {
  memoryFallback = undefined;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ditto */
  }
}
