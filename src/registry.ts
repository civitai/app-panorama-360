import { registerRunElements } from '@civitai/comfy-run-kit/elements';

import { PanoApp } from './components/pano-app.js';
import { PanoControls } from './components/pano-controls.js';
import { PanoGallery } from './components/pano-gallery.js';
import { PanoStatus } from './components/pano-status.js';
import { PanoViewer } from './components/pano-viewer.js';

const ELEMENTS: Array<[string, CustomElementConstructor]> = [
  ['pano-viewer', PanoViewer],
  ['pano-controls', PanoControls],
  ['pano-status', PanoStatus],
  ['pano-gallery', PanoGallery],
  ['pano-app', PanoApp],
];

/** Define every element once (idempotent for HMR / test re-imports). */
export function registerElements(): void {
  registerRunElements();
  for (const [name, ctor] of ELEMENTS) {
    if (!customElements.get(name)) customElements.define(name, ctor);
  }
}
