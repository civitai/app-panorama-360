// <pano-viewer> — Photo Sphere Viewer around one equirectangular url. Light
// DOM (PSV's global CSS must style the container); PSV imported lazily to
// keep the initial bundle light. `pano-viewer-error` fires when the texture
// won't load — WebGL needs CORS headers where a plain <img> doesn't.

import type { Viewer } from '@photo-sphere-viewer/core';

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
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"' +
      ' stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="9"/>' +
      '<ellipse cx="12" cy="12" rx="9" ry="3.6"/>' +
      '<path d="M12 3v18"/></svg>';
    const text = document.createElement('span');
    text.textContent =
      'Your 360° panorama will appear here — drag to look around once it does.';
    this.#placeholder.append(icon, text);
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

  /** Flat <img> fallback (plus open-in-tab) when WebGL/CORS blocks the texture. */
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
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '360° view unavailable here — open the image in a new tab';
    note.appendChild(link);
    this.#stage.append(img, note);
    this.#placeholder = null;
  }
}
