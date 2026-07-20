import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Record any attempt to construct the Photo Sphere Viewer. On a WebGL-2-less
// environment the <pano-viewer> pre-check must short-circuit to the flat image
// BEFORE this is ever imported/constructed.
const viewerCtor = vi.fn();
vi.mock('@photo-sphere-viewer/core', () => ({
  Viewer: class {
    constructor(opts: unknown) {
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

beforeEach(() => {
  document.body.innerHTML = '';
  viewerCtor.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<pano-viewer> without WebGL 2', () => {
  it('shows the flat fallback <img> with the generated url and never constructs PSV', async () => {
    // Report WebGL 2 as UNSUPPORTED (jsdom has none anyway, but be explicit so
    // the probe short-circuits deterministically).
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      (() => null) as HTMLCanvasElement['getContext'],
    );

    const viewer = document.createElement('pano-viewer') as PanoViewer;
    document.body.appendChild(viewer);
    viewer.src = PANO_URL;
    await flush();

    // The Photo Sphere Viewer must NOT have been constructed.
    expect(viewerCtor).not.toHaveBeenCalled();

    // The flat fallback <img> shows the generated panorama.
    const img = viewer.querySelector<HTMLImageElement>('img.pn-viewer-fallback');
    expect(img).not.toBeNull();
    expect(img!.src).toBe(PANO_URL);

    // The why-note explains the WebGL-2 gap and keeps the open-in-tab link.
    const note = viewer.querySelector('.pn-viewer-placeholder');
    expect(note?.textContent).toContain('WebGL 2');
    const link = viewer.querySelector<HTMLAnchorElement>('.pn-viewer-placeholder a');
    expect(link?.href).toBe(PANO_URL);
    expect(link?.target).toBe('_blank');
  });
});
