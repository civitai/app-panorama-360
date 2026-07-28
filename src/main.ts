import '@photo-sphere-viewer/core/index.css';
// Design-system tokens (`--civitai-*`) — an explicit, first-paint token source.
// Imported BEFORE ./styles.css so the app's `--pn-*` layer resolves against it.
import '@civitai/theme/styles.css';
import './styles.css';

import { registerElements } from './registry.js';
import { installStorageFallback } from './safe-storage.js';

// The production block iframe has no `allow-same-origin`, so `localStorage`
// THROWS at its opaque origin. Install the in-memory fallback as early as the
// module graph allows, so any dependency that touches storage unguarded gets a
// working object instead of a SecurityError. Static imports are hoisted above
// this statement, so it cannot protect import-time access in the modules above
// (none of which touch storage today); the guarantee that matters is in
// <pano-viewer>, which re-invokes this immediately before dynamically importing
// Photo Sphere Viewer — the one dependency known to read storage unguarded.
installStorageFallback();

// Production builds set no harness env, so the dynamic import is statically
// dead and the whole dev harness is tree-shaken out of `vite build`.
async function boot(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing from index.html');

  if (import.meta.env.VITE_DEV_HARNESS === 'true') {
    const { mountHarness } = await import('./harness.js');
    await mountHarness(root);
    return;
  }

  // Page app (see block.manifest.json `page{}`): a bare-subdomain top-level load
  // is handled by the platform edge redirect to /apps/run/panorama-360 — no
  // in-app <BlockGate> direct-load fallback needed (and <BlockGate> is React;
  // this app is vanilla).
  registerElements();
  root.appendChild(document.createElement('pano-app'));
}

void boot();
