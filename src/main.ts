import '@photo-sphere-viewer/core/index.css';
import './styles.css';

import { registerElements } from './registry.js';

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
