// jsdom setup for the `dom` vitest project (*.dom.test.ts).
//
// Photo Sphere Viewer needs WebGL + real layout, neither of which jsdom has —
// component tests mock '@photo-sphere-viewer/core' per-suite via vi.mock.

// Guarantee a working `window.localStorage`/`sessionStorage` for the layer-AIR
// cache tests. The `dom` project sets a non-opaque jsdom `url` (vite.config.ts
// environmentOptions) so jsdom CAN provide Storage — but on Node ≥22 the runtime
// defines its own experimental `globalThis.localStorage`, and vitest's
// populateGlobal skips copying jsdom's Storage over any pre-existing global key
// it doesn't recognise (`localStorage` isn't in its KEYS list), leaving Node's
// stub (which is `undefined` without `--localstorage-file`). Where the env
// already exposes a working Storage (older Node), this is a no-op. The
// replacement below is a spec-faithful in-memory Storage — the same shape jsdom
// itself provides — so the tests exercise a genuine round-trip, not a mock.
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }
}

function hasWorkingStorage(name: 'localStorage' | 'sessionStorage'): boolean {
  try {
    const s = (globalThis as unknown as Record<string, Storage | undefined>)[name];
    return !!s && typeof s.setItem === 'function' && typeof s.getItem === 'function';
  } catch {
    return false;
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (!hasWorkingStorage(name)) {
    const store = new MemoryStorage();
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get: () => store,
    });
  }
}

// jsdom has no ResizeObserver; <pano-app> uses it for RESIZE_IFRAME reports.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

export {};
