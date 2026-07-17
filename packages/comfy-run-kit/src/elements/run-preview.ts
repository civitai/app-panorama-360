// <civitai-run-preview> — the sampler's live preview image (trace opcode-2
// frames). Shown only while the run is in flight; the finished image is the
// app's to display.

import type { RunState } from '../types.js';
import { RunStateElement } from './base.js';

const PREVIEW_PHASES = new Set(['starting', 'running']);

export class RunPreviewElement extends RunStateElement {
  protected build(root: ShadowRoot): void {
    const figure = document.createElement('figure');
    figure.style.margin = '0';
    figure.innerHTML = `
      <img class="preview" part="image" alt="Live sampler preview" />
      <figcaption class="muted">Live preview</figcaption>
    `;
    root.appendChild(figure);
  }

  protected update(state: RunState): void {
    this.hidden = !state.previewUrl || !PREVIEW_PHASES.has(state.phase);
    if (this.hidden) return;
    const img = this.query<HTMLImageElement>('img.preview');
    if (state.previewUrl && img.getAttribute('src') !== state.previewUrl) {
      img.setAttribute('src', state.previewUrl);
    }
  }
}
