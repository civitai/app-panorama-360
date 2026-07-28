// In-memory `Storage` fallback for the OPAQUE-ORIGIN block sandbox.
//
// A block iframe on the `unverified` trust tier is framed as
// `sandbox="allow-scripts allow-forms"` — deliberately WITHOUT
// `allow-same-origin` — so the document runs at an opaque origin and merely
// *reading* the property throws:
//
//   SecurityError: Failed to read the 'localStorage' property from 'Window':
//   The document is sandboxed and lacks the 'allow-same-origin' flag.
//
// Our own call sites guard every access (see nodepack.ts), but a THIRD-PARTY
// dependency cannot be guarded from the outside. Photo Sphere Viewer's
// `SYSTEM.load()` runs an unguarded `TOUCH_KEY in localStorage` for its
// touch-support cache. The SecurityError is swallowed by PSV's own
// `try { SYSTEM.load() } catch { showError(config.lang.webglError) }` and
// surfaced to the user as "Your browser does not seem to support WebGL" — on
// machines whose WebGL 2 is perfectly fine. Because PSV *catches* it, the
// `try/catch` around `new Viewer(...)` in <pano-viewer> never fires either, so
// the flat-image fallback never runs and the user dead-ends on PSV's overlay.
//
// (Measured, not assumed: in a real browser an `allow-scripts`-only iframe
// reports `webgl2: true` while `localStorage` throws — the sandbox does not
// block WebGL, only storage.)
//
// So install a spec-shaped in-memory Storage before any dependency can touch
// it. It is session-scoped — nothing survives a reload — which is the honest
// semantic at an opaque origin: there is no origin to persist against. Every
// consumer here treats storage as a cache, never as a source of truth.

/** Which globals this call actually replaced. */
export interface StorageFallbackResult {
  localStorage: boolean;
  sessionStorage: boolean;
}

const STORAGE_NAMES = ['localStorage', 'sessionStorage'] as const;
type StorageName = (typeof STORAGE_NAMES)[number];

const PROBE_KEY = '__pano360_storage_probe__';

/**
 * A `Storage` work-alike backed by a Map.
 *
 * Real `Storage` is an exotic object: `s.foo = 1`, `'foo' in s` and `s.foo` are
 * aliases for `setItem`/`getItem`. Libraries use that form — PSV's touch probe
 * is literally `KEY in localStorage` followed by `localStorage[KEY] === 'true'`
 * — so a plain class is NOT sufficient. Hence the Proxy.
 */
export function createMemoryStorage(): Storage {
  const map = new Map<string, string>();

  const api = {
    getItem(key: string): string | null {
      const k = String(key);
      return map.has(k) ? (map.get(k) as string) : null;
    },
    setItem(key: string, value: string): void {
      map.set(String(key), String(value));
    },
    removeItem(key: string): void {
      map.delete(String(key));
    },
    clear(): void {
      map.clear();
    },
    key(index: number): string | null {
      return Array.from(map.keys())[index] ?? null;
    },
    get length(): number {
      return map.size;
    },
  };

  // `Reflect.has` walks the prototype chain, so `'toString' in storage` stays
  // true exactly as it is for a real Storage instance. Only keys that are NOT
  // part of the Storage API fall through to the backing map.
  const isApiKey = (prop: string | symbol): boolean =>
    typeof prop === 'symbol' || Reflect.has(api, prop);

  return new Proxy(api, {
    get(target, prop, receiver) {
      if (isApiKey(prop)) return Reflect.get(target, prop, receiver);
      return map.get(prop as string);
    },
    set(target, prop, value, receiver) {
      if (isApiKey(prop)) return Reflect.set(target, prop, value, receiver);
      map.set(prop as string, String(value));
      return true;
    },
    has(_target, prop) {
      return isApiKey(prop) || map.has(prop as string);
    },
    deleteProperty(target, prop) {
      if (isApiKey(prop)) return Reflect.deleteProperty(target, prop);
      map.delete(prop as string);
      return true;
    },
    // Enumeration sees only stored keys — matching real Storage, where
    // `Object.keys(localStorage)` lists the entries, not the methods.
    ownKeys() {
      return Array.from(map.keys());
    },
    getOwnPropertyDescriptor(target, prop) {
      if (!isApiKey(prop) && map.has(prop as string)) {
        return {
          value: map.get(prop as string),
          writable: true,
          enumerable: true,
          configurable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  }) as unknown as Storage;
}

/**
 * Is `scope[name]` a Storage we can actually use?
 *
 * Reading the property can succeed while writing still throws (storage
 * disabled, private-browsing quirks, quota exhausted), so probe a real
 * round-trip rather than trusting the getter. Any failure means "use memory" —
 * safe here because every consumer treats storage as a discardable cache.
 */
function storageWorks(scope: object, name: StorageName): boolean {
  try {
    const storage = (scope as Record<string, unknown>)[name] as Storage | undefined;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      return false;
    }
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace any unusable `localStorage`/`sessionStorage` on `scope` with an
 * in-memory Storage, so third-party code that touches it unguarded cannot throw.
 *
 * Idempotent: once a fallback is installed the round-trip probe succeeds, so a
 * second call is a no-op and previously stored values survive. A working
 * Storage is never replaced.
 */
export function installStorageFallback(scope: object = globalThis): StorageFallbackResult {
  const result: StorageFallbackResult = { localStorage: false, sessionStorage: false };

  for (const name of STORAGE_NAMES) {
    if (storageWorks(scope, name)) continue;
    try {
      Object.defineProperty(scope, name, {
        value: createMemoryStorage(),
        configurable: true,
        writable: false,
        enumerable: false,
      });
      result[name] = true;
    } catch {
      // Non-configurable in this engine — nothing more we can do. Our own call
      // sites still guard, so this degrades rather than breaking the boot.
    }
  }

  return result;
}
