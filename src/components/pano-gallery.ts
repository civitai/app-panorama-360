// <pano-gallery> — session-scoped strip of finished panoramas. Click a
// thumbnail to swap it into the viewer (`pano-select`, bubbles).

export class PanoGallery extends HTMLElement {
  #items: string[] = [];
  #selected: string | null = null;

  set items(value: string[]) {
    this.#items = value;
    this.#render();
  }

  set selected(value: string | null) {
    this.#selected = value;
    this.#render();
  }

  #render(): void {
    this.textContent = '';
    if (this.#items.length < 2) return;
    const row = document.createElement('div');
    row.className = 'pn-gallery-row';
    for (const url of this.#items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pn-thumb';
      btn.setAttribute('aria-pressed', url === this.#selected ? 'true' : 'false');
      btn.title = 'Show this panorama';
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Generated panorama thumbnail';
      img.loading = 'lazy';
      btn.appendChild(img);
      btn.addEventListener('click', () =>
        this.dispatchEvent(new CustomEvent('pano-select', { bubbles: true, detail: { url } })),
      );
      row.appendChild(btn);
    }
    this.appendChild(row);
  }
}
