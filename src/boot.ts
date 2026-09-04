import { registerElements } from './registry.js';
import { removeBootSkeleton } from './bootTheme.js';

/**
 * Mount the app into `#root` and take index.html's boot skeleton down.
 *
 * Lives in its own module rather than inline in main.ts so the skeleton handoff is
 * DIRECTLY testable — main.ts is a side-effecting entry (CSS imports, the storage
 * fallback, a bare `void boot()`), and a test that had to import it would be
 * asserting against the entry's side effects rather than against this sequence.
 * src/bootSkeleton.dom.test.ts drives this function, not a copy of it.
 *
 * Production builds set no harness env, so the dynamic import below is statically
 * dead and the whole dev harness is tree-shaken out of `vite build`.
 */
export async function boot(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing from index.html');

  if (import.meta.env.VITE_DEV_HARNESS === 'true') {
    const { mountHarness } = await import('./harness.js');
    await mountHarness(root);
    // The harness renders its own chrome into #root; whether that replaced the
    // skeleton or appended beside it is the harness's business, so sweep either
    // way. `removeBootSkeleton` is idempotent and a no-op on an already-clean root.
    removeBootSkeleton(root);
    return;
  }

  // Page app (see block.manifest.json `page{}`): a bare-subdomain top-level load
  // is handled by the platform edge redirect to /apps/run/panorama-360 — no
  // in-app <BlockGate> direct-load fallback needed (and <BlockGate> is React;
  // this app is vanilla).
  registerElements();
  root.appendChild(document.createElement('pano-app'));

  // 🔴 AFTER the append, and this ordering is deliberate on both sides.
  //
  // AFTER, not before: `<pano-app>`'s connectedCallback builds its card
  // synchronously during appendChild, so removing the skeleton here swaps painted
  // content for painted content inside a single task and no frame can show an empty
  // #root. Removing first would open exactly that gap — with the host's veil stood
  // down by `bootSkeleton: true`, a gap is a visible white/black flash.
  //
  // And EXPLICITLY, because nothing else will: this app appends, it does not
  // render-into. See removeBootSkeleton()'s own note. If the append above throws,
  // this line never runs and the viewer keeps the skeleton instead of a blank
  // iframe, which is the failure mode we want.
  removeBootSkeleton(root);
}
