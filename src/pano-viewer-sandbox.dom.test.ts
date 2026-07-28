// Regression: the production block iframe (trust tier `unverified`) is framed
// as `sandbox="allow-scripts allow-forms"` — no `allow-same-origin` — so
// `localStorage` throws a SecurityError at its opaque origin. Photo Sphere
// Viewer reads `localStorage` UNGUARDED in `SYSTEM.load()`, catches the throw
// itself, and mislabels it as `lang.webglError` ("Your browser does not seem to
// support WebGL") — dead-ending the viewer on hardware whose WebGL 2 is fine.
//
// <pano-viewer> must therefore install the in-memory Storage fallback BEFORE it
// dynamically imports PSV. Lives in its own file because `isWebGL2Supported()`
// memoizes its probe, and pano-viewer.dom.test.ts pins that memo to `false`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PSV_TOUCH_KEY = 'photoSphereViewer_touchSupport';

const viewerCtor = vi.fn();
/** What PSV's `SYSTEM.load()` touch probe saw when the Viewer was constructed. */
let systemLoadError: string | null = null;

vi.mock('@photo-sphere-viewer/core', () => ({
  Viewer: class {
    constructor(opts: unknown) {
      // Faithful stand-in for PSV's `SYSTEM.load()`: an unguarded read of
      // `localStorage`, with PSV's own swallow-and-mislabel behaviour.
      try {
        const ls = globalThis.localStorage as unknown as Record<string, unknown>;
        if (PSV_TOUCH_KEY in ls) void (ls[PSV_TOUCH_KEY] === 'true');
        ls[PSV_TOUCH_KEY] = true;
      } catch (err) {
        systemLoadError = err instanceof Error ? err.message : String(err);
      }
      viewerCtor(opts);
    }
    addEventListener(): void {}
    async setPanorama(): Promise<void> {}
    destroy(): void {}
  },
}));

import { PanoViewer } from './components/pano-viewer.js';

if (!customElements.get('pano-viewer')) customElements.define('pano-viewer', PanoViewer);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const PANO_URL = 'https://blob/generated-pano.png';

let restoreStorage: (() => void) | null = null;

/** Make `localStorage` throw exactly as an opaque-origin document does. */
function sandboxStorage(): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException(
        "Failed to read the 'localStorage' property from 'Window': The document " +
          "is sandboxed and lacks the 'allow-same-origin' flag.",
        'SecurityError',
      );
    },
  });
  restoreStorage = () => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  viewerCtor.mockClear();
  systemLoadError = null;

  // WebGL 2 IS available — this is the whole point. The failure under test is
  // NOT a GPU gap; it is the sandbox's opaque origin. (Confirmed in a real
  // browser: an `allow-scripts`-only iframe reports `webgl2: true`.)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((
    contextId: string,
  ) => (contextId === 'webgl2' ? ({} as unknown) : null)) as HTMLCanvasElement['getContext']);
});

afterEach(() => {
  restoreStorage?.();
  restoreStorage = null;
  vi.restoreAllMocks();
});

describe('<pano-viewer> in an opaque-origin sandbox (localStorage throws)', () => {
  it('still mounts the interactive viewer when WebGL 2 is available', async () => {
    sandboxStorage();

    const viewer = document.createElement('pano-viewer') as PanoViewer;
    document.body.appendChild(viewer);
    viewer.src = PANO_URL;
    await flush();

    // Red without the fix: PSV's storage read throws, PSV reports it as a WebGL
    // failure and the user dead-ends.
    expect(systemLoadError).toBeNull();
    expect(viewerCtor).toHaveBeenCalledTimes(1);

    // And the user is NOT pushed onto the flat-image fallback.
    expect(viewer.querySelector('img.pn-viewer-fallback')).toBeNull();
  });

  it('leaves storage usable for the rest of the app after mounting', async () => {
    sandboxStorage();

    const viewer = document.createElement('pano-viewer') as PanoViewer;
    document.body.appendChild(viewer);
    viewer.src = PANO_URL;
    await flush();

    // nodepack.ts's layer-AIR cache guards its own access, but it should now
    // get a real round-trip rather than always falling back to memory.
    expect(() => globalThis.localStorage.setItem('probe', '1')).not.toThrow();
    expect(globalThis.localStorage.getItem('probe')).toBe('1');
  });

  it('still prefers the flat fallback when WebGL 2 is genuinely absent', async () => {
    // Both problems at once: no WebGL 2 AND a throwing localStorage. The
    // WebGL-2 pre-check must win and PSV must never be constructed.
    //
    // `isWebGL2Supported()` memoizes, and the tests above have already pinned
    // that memo to `true`, so take a FRESH module instance (and a distinct tag
    // name — a custom element cannot be redefined) instead of relying on test
    // ordering.
    vi.resetModules();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      (() => null) as HTMLCanvasElement['getContext'],
    );
    sandboxStorage();

    const { PanoViewer: FreshPanoViewer } = await import('./components/pano-viewer.js');
    if (!customElements.get('pano-viewer-no-webgl2')) {
      customElements.define('pano-viewer-no-webgl2', FreshPanoViewer);
    }

    const viewer = document.createElement('pano-viewer-no-webgl2') as PanoViewer;
    document.body.appendChild(viewer);
    viewer.src = PANO_URL;
    await flush();

    expect(viewerCtor).not.toHaveBeenCalled();
    const img = viewer.querySelector<HTMLImageElement>('img.pn-viewer-fallback');
    expect(img).not.toBeNull();
    expect(img!.src).toBe(PANO_URL);
  });
});
