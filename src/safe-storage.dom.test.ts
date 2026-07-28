import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryStorage, installStorageFallback } from './safe-storage.js';

// The exact key shape Photo Sphere Viewer uses for its touch-support cache
// (`${LOCAL_STORAGE_PREFIX}_touchSupport`).
const PSV_TOUCH_KEY = 'photoSphereViewer_touchSupport';

const SECURITY_ERROR_MESSAGE =
  "Failed to read the 'localStorage' property from 'Window': The document is " +
  "sandboxed and lacks the 'allow-same-origin' flag.";

/**
 * Replace a global with a getter that throws exactly like an opaque-origin
 * browser does, and hand back a restore function.
 */
function makeStorageThrow(name: 'localStorage' | 'sessionStorage'): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new DOMException(SECURITY_ERROR_MESSAGE, 'SecurityError');
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete (globalThis as Record<string, unknown>)[name];
  };
}

const restores: Array<() => void> = [];

afterEach(() => {
  while (restores.length) restores.pop()?.();
});

describe('createMemoryStorage', () => {
  it('supports the full Storage API', () => {
    const s = createMemoryStorage();

    expect(s.length).toBe(0);
    expect(s.getItem('missing')).toBeNull();

    s.setItem('a', '1');
    s.setItem('b', '2');
    expect(s.getItem('a')).toBe('1');
    expect(s.length).toBe(2);
    expect(s.key(0)).toBe('a');
    expect(s.key(9)).toBeNull();

    s.removeItem('a');
    expect(s.getItem('a')).toBeNull();
    expect(s.length).toBe(1);

    s.clear();
    expect(s.length).toBe(0);
  });

  it('coerces keys and values to strings like a real Storage', () => {
    const s = createMemoryStorage();
    s.setItem('n', 1 as unknown as string);
    expect(s.getItem('n')).toBe('1');
    s.setItem('bool', true as unknown as string);
    expect(s.getItem('bool')).toBe('true');
  });

  it("honours PSV's exotic access pattern (`in`, bracket get/set)", () => {
    // This is the literal shape of PSV's `SYSTEM.load()` touch probe:
    //   if (KEY in localStorage) enabled = localStorage[KEY] === 'true';
    //   ...later... localStorage[KEY] = true;
    const s = createMemoryStorage() as unknown as Record<string, unknown>;

    expect(PSV_TOUCH_KEY in s).toBe(false);

    s[PSV_TOUCH_KEY] = true;

    expect(PSV_TOUCH_KEY in s).toBe(true);
    // PSV compares against the STRING 'true' — the shim must stringify on write.
    expect(s[PSV_TOUCH_KEY]).toBe('true');
    expect(s[PSV_TOUCH_KEY] === 'true').toBe(true);

    delete s[PSV_TOUCH_KEY];
    expect(PSV_TOUCH_KEY in s).toBe(false);
  });

  it('enumerates stored keys only, not the API methods', () => {
    const s = createMemoryStorage();
    s.setItem('x', '1');
    s.setItem('y', '2');
    expect(Object.keys(s).sort()).toEqual(['x', 'y']);
  });

  it('still exposes the Storage methods through the proxy', () => {
    const s = createMemoryStorage();
    expect(typeof s.getItem).toBe('function');
    expect(typeof s.setItem).toBe('function');
    expect('getItem' in s).toBe(true);
    expect('length' in s).toBe(true);
  });

  it('lets an API-named key shadow the method, as a real Storage does', () => {
    // Measured against a real browser Storage rather than assumed: assigning
    // `localStorage.getItem = 'nope'` genuinely replaces the method (it becomes
    // an own string property and later calls throw TypeError). The shim matches
    // that rather than inventing safer-but-divergent semantics. No consumer
    // does this; the test pins the parity.
    const s = createMemoryStorage();
    (s as unknown as Record<string, unknown>).getItem = 'nope';
    expect(typeof s.getItem).toBe('string');
  });
});

describe('installStorageFallback', () => {
  it('installs a usable fallback when reading localStorage throws', () => {
    restores.push(makeStorageThrow('localStorage'));

    // Precondition: the getter throws, exactly as in the opaque-origin sandbox.
    expect(() => globalThis.localStorage).toThrow(/allow-same-origin/);

    const result = installStorageFallback();
    expect(result.localStorage).toBe(true);

    // The whole point: touching storage no longer throws.
    expect(() => globalThis.localStorage).not.toThrow();
    globalThis.localStorage.setItem('k', 'v');
    expect(globalThis.localStorage.getItem('k')).toBe('v');
  });

  it("lets PSV's unguarded touch probe run without throwing", () => {
    restores.push(makeStorageThrow('localStorage'));
    installStorageFallback();

    // Verbatim reproduction of the PSV code path that broke production.
    expect(() => {
      const ls = globalThis.localStorage as unknown as Record<string, unknown>;
      let enabled = false;
      if (PSV_TOUCH_KEY in ls) enabled = ls[PSV_TOUCH_KEY] === 'true';
      ls[PSV_TOUCH_KEY] = true;
      return enabled;
    }).not.toThrow();
  });

  it('also repairs sessionStorage', () => {
    restores.push(makeStorageThrow('sessionStorage'));
    const result = installStorageFallback();
    expect(result.sessionStorage).toBe(true);
    expect(() => globalThis.sessionStorage.setItem('a', 'b')).not.toThrow();
  });

  it('leaves a working storage untouched', () => {
    // test-setup.ts guarantees a working Storage in this project.
    const before = globalThis.localStorage;
    globalThis.localStorage.setItem('preexisting', 'kept');

    const result = installStorageFallback();

    expect(result.localStorage).toBe(false);
    expect(globalThis.localStorage).toBe(before);
    expect(globalThis.localStorage.getItem('preexisting')).toBe('kept');
    globalThis.localStorage.removeItem('preexisting');
  });

  it('is idempotent and preserves values already written to the fallback', () => {
    restores.push(makeStorageThrow('localStorage'));

    expect(installStorageFallback().localStorage).toBe(true);
    globalThis.localStorage.setItem('keep', 'me');
    const first = globalThis.localStorage;

    // Second call must be a no-op — the fallback now round-trips, so it reads
    // as a working Storage.
    expect(installStorageFallback().localStorage).toBe(false);
    expect(globalThis.localStorage).toBe(first);
    expect(globalThis.localStorage.getItem('keep')).toBe('me');
  });

  it('falls back when the getter works but writing throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    restores.push(() => {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    });
    // Readable, but every write throws (storage disabled / quota exhausted).
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        },
      },
    });

    expect(installStorageFallback().localStorage).toBe(true);
    expect(() => globalThis.localStorage.setItem('a', 'b')).not.toThrow();
  });

  it('does not throw when the property cannot be redefined', () => {
    const scope = {};
    Object.defineProperty(scope, 'localStorage', {
      configurable: false,
      get() {
        throw new DOMException('nope', 'SecurityError');
      },
    });

    // Non-configurable → cannot install, but must degrade quietly.
    expect(() => installStorageFallback(scope)).not.toThrow();
    expect(installStorageFallback(scope).localStorage).toBe(false);
  });
});
