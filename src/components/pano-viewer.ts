// <pano-viewer> — Photo Sphere Viewer around one equirectangular url. Light
// DOM (PSV's global CSS must style the container); PSV imported lazily to
// keep the initial bundle light. `pano-viewer-error` fires when the texture
// won't load — WebGL needs CORS headers where a plain <img> doesn't.

import type { Viewer } from '@photo-sphere-viewer/core';

// PSV's Viewer HARD-requires WebGL 2 and throws `PSVError: WebGL 2 is not
// supported` from its ASYNC load (so a synchronous try/catch around
// `new Viewer(...)` never catches it) on WebGL-1-only environments — hardware
// acceleration off, some Linux GPU/driver setups (reproduced in Firefox AND
// Brave, i.e. an environment WebGL-2 gap, not an iframe/sandbox one). Probe the
// capability ONCE up front so we can fall back to the flat image deterministically
// instead of relying on catching PSV's async throw.
let webgl2Supported: boolean | undefined;
export function isWebGL2Supported(): boolean {
  if (webgl2Supported !== undefined) return webgl2Supported;
  try {
    const canvas = document.createElement('canvas');
    // `getContext` can be absent (non-canvas stub) or throw — treat either as
    // "no WebGL 2" rather than letting it bubble.
    webgl2Supported = typeof canvas.getContext === 'function' && !!canvas.getContext('webgl2');
  } catch {
    webgl2Supported = false;
  }
  return webgl2Supported;
}

export class PanoViewer extends HTMLElement {
  #viewer: Viewer | null = null;
  #stage: HTMLDivElement | null = null;
  #placeholder: HTMLDivElement | null = null;
  #src: string | null = null;
  #applyToken = 0;

  connectedCallback(): void {
    if (this.#stage) return;
    this.#stage = document.createElement('div');
    this.#stage.className = 'pn-viewer-stage';
    this.#placeholder = document.createElement('div');
    this.#placeholder.className = 'pn-viewer-placeholder';
    this.#placeholder.textContent =
      'Your 360° panorama will appear here — drag to look around once it does.';
    this.#stage.appendChild(this.#placeholder);
    this.appendChild(this.#stage);
    if (this.#src) void this.#apply(this.#src);
  }

  disconnectedCallback(): void {
    this.#applyToken += 1;
    this.#viewer?.destroy();
    this.#viewer = null;
  }

  get src(): string | null {
    return this.#src;
  }

  set src(value: string | null) {
    if (value === this.#src) return;
    this.#src = value;
    if (!this.#stage) return; // applied on connect
    void this.#apply(value);
  }

  async #apply(value: string | null): Promise<void> {
    const token = ++this.#applyToken;
    if (!value) {
      this.#viewer?.destroy();
      this.#viewer = null;
      if (this.#placeholder) this.#placeholder.style.display = '';
      return;
    }
    // No WebGL 2 → skip PSV entirely and show the flat panorama deterministically.
    // (PSV throws `WebGL 2 is not supported` from its async load, which the
    // try/catch below can't reliably catch — hence the up-front short-circuit.)
    if (!isWebGL2Supported()) {
      this.#viewer?.destroy();
      this.#viewer = null;
      this.#showFallback(value);
      return;
    }
    try {
      if (!this.#viewer) {
        const { Viewer } = await import('@photo-sphere-viewer/core');
        if (token !== this.#applyToken || !this.#stage) return;
        this.#viewer = new Viewer({
          container: this.#stage,
          panorama: value,
          navbar: [
            'zoom',
            'move',
            // The production block iframe is sandboxed without fullscreen
            // permission; offering a button that throws is worse than none.
            ...(document.fullscreenEnabled ? ['fullscreen'] : []),
          ],
          defaultZoomLvl: 0,
          touchmoveTwoFingers: false,
        });
        this.#viewer.addEventListener('ready', () => {
          if (this.#placeholder) this.#placeholder.style.display = 'none';
        });
      } else {
        await this.#viewer.setPanorama(value, { transition: false });
        if (this.#placeholder) this.#placeholder.style.display = 'none';
      }
    } catch (err) {
      if (token !== this.#applyToken) return;
      this.#viewer?.destroy();
      this.#viewer = null;
      this.dispatchEvent(
        new CustomEvent('pano-viewer-error', {
          bubbles: true,
          detail: { url: value, message: err instanceof Error ? err.message : String(err) },
        }),
      );
      this.#showFallback(value);
    }
  }

  /**
   * Flat <img> fallback (plus a why-line and open-in-tab) when WebGL 2 is absent
   * or CORS/texture load blocks the interactive viewer. The generated panorama
   * is still fully useful as a flat image.
   */
  #showFallback(url: string): void {
    if (!this.#stage) return;
    this.#stage.textContent = '';
    const img = document.createElement('img');
    img.className = 'pn-viewer-fallback';
    img.src = url;
    img.alt = 'Generated 360° panorama (flat preview)';
    const note = document.createElement('div');
    note.className = 'pn-viewer-placeholder';
    note.style.placeItems = 'end center';
    // Explain WHY the interactive viewer isn't showing so a WebGL-2-less user
    // knows it's their browser/GPU, not a broken render.
    const why = document.createElement('div');
    why.textContent =
      'Interactive 360° needs WebGL 2 — try enabling hardware acceleration in your browser.';
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open the image in a new tab';
    note.append(why, link);
    this.#stage.append(img, note);
    this.#placeholder = null;
  }
}
