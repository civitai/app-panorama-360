/**
 * The pre-`ready` boot window: what theme to paint with, and how the boot
 * skeleton in index.html gets taken down.
 *
 * Both halves exist because `bootSkeleton: true` in block.manifest.json makes the
 * full-page run host stand down its opaque veil over the iframe. That veil was
 * HIDING these, not compensating for them.
 */

export type BootTheme = 'dark' | 'light';

/**
 * The theme to PAINT WITH before `ready`.
 *
 * 🔴 WHY THIS EXISTS. `session.getSnapshot().theme` is a SENTINEL before `ready`,
 * not a signal: the SDK's pre-init snapshot hardcodes `theme: 'light'`
 * (@civitai/blocks-react `dist/internal/transport.js`, EMPTY_SNAPSHOT) and the
 * transport returns it unchanged. So the old stamp in <pano-app>,
 *
 *     dataset.theme = snapshot.theme === 'light' ? 'light' : 'dark'
 *
 * READS as "default to dark" and is the exact opposite: the sentinel IS the literal
 * 'light', so every viewer resolved LIGHT until BLOCK_INIT landed. With the boot
 * skeleton dark that is dark → light → dark, a NEW flash introduced at exactly the
 * moment the host's veil comes down. Never branch on `theme` in a `!ready` path;
 * use `paintTheme()` instead.
 *
 * 🔴 THE ATTRIBUTE READ IS FORWARD-COMPATIBLE, NOT LOAD-BEARING HERE. This app's
 * pinned SDK cannot decode the init fragment, so index.html ships no inline reader
 * and nothing sets `data-civitai-boot-theme` today — the OS query below is what
 * actually answers, matching the stylesheet's `@media (prefers-color-scheme: light)`
 * exactly. The branch is kept so that adding the reader later needs no change here.
 *
 * Unknown means DARK, here and in index.html and in `<meta name="color-scheme">`.
 */
export function bootThemeGuess(): BootTheme {
  try {
    const recorded = document.documentElement.getAttribute('data-civitai-boot-theme');
    if (recorded === 'dark' || recorded === 'light') return recorded;
    // The OS guess, asked the same way round as the stylesheet: LIGHT is the
    // positive case, so `no-preference` and any UA without the query land on dark.
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
  } catch {
    // A hardened embedder can throw out of matchMedia. Fall through to dark.
  }
  return 'dark';
}

/**
 * The value to stamp on `<html>`'s `data-theme`.
 *
 * After `ready` the HOST's theme is authoritative and wins outright — this helper
 * exists only to keep the pre-`ready` stamp off the sentinel.
 */
export function paintTheme(ready: boolean, hostTheme: string | undefined): string {
  return ready && hostTheme ? hostTheme : bootThemeGuess();
}

/**
 * Take the boot skeleton down once the real app is in the DOM.
 *
 * 🔴 THIS FUNCTION IS THE WHOLE REASON THIS APP WAS HARDER THAN THE REACT ONES.
 * They mount with `createRoot(container).render(...)`, which CLEARS the container's
 * children before its first commit, so a skeleton inside #root removes itself and
 * those apps ship no cleanup code at all. That is a react-dom behaviour, not a law.
 * This app is vanilla custom elements and boot() APPENDS
 * (`root.appendChild(document.createElement('pano-app'))`), which adds a sibling and
 * removes nothing — so without this call the skeleton sits above the live app
 * forever. It is not optional and it is not decoration.
 *
 * Scoped to the passed root and matched by ATTRIBUTE so it cannot depend on class
 * names a bundler may mangle. Removing every match rather than the first: a second
 * marked node is a defect, and leaving it behind would be a silent one.
 *
 * Idempotent, and a no-op when the mount path already cleared the container (the
 * dev harness replaces #root's content), so both boot branches can call it.
 */
export function removeBootSkeleton(root: ParentNode): void {
  for (const el of root.querySelectorAll('[data-boot-skeleton]')) el.remove();
}
