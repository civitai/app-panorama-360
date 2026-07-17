import { beforeEach, describe, expect, it } from 'vitest';

import { clearCachedLayerAir, getCachedLayerAir, setCachedLayerAir } from './nodepack.js';

const LAYER = 'urn:air:comfy:nodepacklayer:comfyregistry:spinagon/comfyui-seamless-tiling@1.0.0+ff';

describe('layer-AIR cache', () => {
  beforeEach(() => {
    clearCachedLayerAir();
    window.localStorage.clear();
  });

  it('round-trips through localStorage', () => {
    expect(getCachedLayerAir()).toBeUndefined();
    setCachedLayerAir(LAYER);
    expect(getCachedLayerAir()).toBe(LAYER);
    clearCachedLayerAir();
    expect(getCachedLayerAir()).toBeUndefined();
  });

  it('falls back to memory when localStorage throws (sandboxed iframe)', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      setCachedLayerAir(LAYER);
      expect(getCachedLayerAir()).toBe(LAYER);
      clearCachedLayerAir();
      expect(getCachedLayerAir()).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
