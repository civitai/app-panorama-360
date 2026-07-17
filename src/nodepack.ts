// Install-layer AIR cache for the seamless-tiling nodepack. After the first
// 2-step run the orchestrator has captured (and cached server-side) the pack's
// image-specific install layer; remembering the layer AIR lets later runs
// submit single-step. Purely an optimization: the layer goes stale when the
// worker image rolls over, so callers invalidate + retry 2-step on failure.
//
// localStorage access THROWS in a sandboxed iframe without allow-same-origin
// (the production block sandbox), so every access is guarded with an in-memory
// fallback.

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
