import '@photo-sphere-viewer/core/index.css';
// Design-system tokens (`--civitai-*`) — an explicit, first-paint token source.
// Imported BEFORE ./styles.css so the app's `--pn-*` layer resolves against it.
import '@civitai/theme/styles.css';
import './styles.css';

import { boot } from './boot.js';
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

// The mount sequence — including taking index.html's boot skeleton down, which
// this app has to do explicitly — lives in ./boot.ts so it is testable without
// importing this entry's side effects.
void boot();
