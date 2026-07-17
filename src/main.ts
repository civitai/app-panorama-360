import '@photo-sphere-viewer/core/index.css';
import './styles.css';

import { registerElements } from './registry.js';

// Entry. Production builds set no harness env, so the dynamic import below is
// statically dead and the entire dev harness (including the SDK's react-bound
// testing barrel) is tree-shaken out of `vite build`; the block mounts bare and
// the platform is the host. `npm run dev:harness` / `dev:orch` / `dev:live`
// flip VITE_DEV_HARNESS on and pick the host via VITE_HARNESS_MODE.
async function boot(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing from index.html');

  if (import.meta.env.VITE_DEV_HARNESS === 'true') {
    const { mountHarness } = await import('./harness.js');
    await mountHarness(root);
    return;
  }

  registerElements();
  root.appendChild(document.createElement('pano-app'));
}

void boot();
