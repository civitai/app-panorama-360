// 🔴 THIS GUARD EXISTS BECAUSE ITS ABSENCE SHIPPED AN INERT CHANGE IN THE PILOT
// APP OF THIS ROLLOUT. That PR added the whole boot-skeleton mechanism — the
// pre-paint resolution, the dark-base inline stylesheet, the skeleton markup,
// `paintTheme()` — plus 23 tests covering all of it, then merged WITHOUT this key.
// Every test passed, because they each verify the mechanism WORKS; none asserted the
// one line that turns it on.
//
// `bootSkeleton: true` is what makes the full-page run host stand down its opaque
// veil. Without it the host keeps covering the iframe and the entire mechanism is
// dead code nobody can see working or failing. Its counterpart — the skeleton inside
// #root, and in THIS app the explicit removal of it — is asserted by
// src/bootSkeleton.dom.test.ts; all of it must ship together, because the key over an
// EMPTY #root is strictly worse than not opting in at all.
//
// Read off disk rather than imported, for the same reason src/version-lockstep.test.ts
// does: `tsconfig.json` scopes `include` to `src` and does not set
// `resolveJsonModule`, so `import manifest from '../block.manifest.json'` would not
// typecheck.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const MANIFEST = JSON.parse(
  readFileSync(new URL('../block.manifest.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('boot skeleton opt-in', () => {
  it('the manifest declares bootSkeleton', () => {
    // `toBe(true)`, not truthy: the schema types this boolean and the host reads it
    // as one, so a string "true" is a defect that must not pass here.
    expect(MANIFEST.bootSkeleton).toBe(true);
  });

  // A sanity control on the reader itself: if the parse silently produced an empty
  // object, the assertion above would fail rather than pass, but a future refactor
  // could easily invert that. Pin that we are reading the real manifest.
  it('is reading this block`s manifest', () => {
    expect(MANIFEST.blockId).toBe('panorama-360');
  });
});
