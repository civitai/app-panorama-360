// The inline boot styles in index.html hardcode colour literals. Everything else in
// this app is `var(--civitai-*)` with zero hardcoded colour (src/styles.css), and
// that is deliberate — but the boot window is the one place a var is unusable,
// because `@civitai/theme/styles.css` is a render-blocking <link> that has not
// loaded yet. These tests keep that necessary duplication honest: every literal is
// asserted against the INSTALLED @civitai/theme, per region, so a theme bump that
// moves a value fails here instead of shipping a colour jump at handoff.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// `import.meta.url` is a real file URL under the `node` project (this file is
// excluded from the jsdom `dom` project, where it would be an http URL — see
// src/bootSkeleton.dom.test.ts, which has to use process.cwd() for that reason).
const INDEX_HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const THEME_CSS = readFileSync(
  createRequire(import.meta.url).resolve('@civitai/theme/styles.css'),
  'utf8',
);

/**
 * The inline `<style>` body ONLY.
 *
 * 🔴 EVERY CSS LOOKUP GOES THROUGH THIS, not the raw file. Searching the whole
 * document for `@media (prefers-color-scheme: light)` can match a PROSE mention of
 * it in one of index.html's comments rather than the rule itself, and this file's
 * comments are long. A comment is not a rule.
 */
const BOOT_CSS = (() => {
  const m = /<style>([\s\S]*?)<\/style>/.exec(INDEX_HTML);
  if (!m) throw new Error('no inline <style> found in index.html');
  return m[1];
})();

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const end = css.indexOf('}', start);
  if (end === -1) throw new Error(`unterminated block: ${selector}`);
  return css.slice(start, end);
}

function tokenValue(css: string, selector: string, prop: string): string {
  const m = new RegExp(`${prop}:\\s*([^;]+);`).exec(block(css, selector));
  if (!m) throw new Error(`${prop} not found in ${selector}`);
  return m[1].trim().toLowerCase();
}

function bootValue(selector: string, prop: string): string {
  return tokenValue(BOOT_CSS, selector, prop);
}

/** The five `--civitai-*` tokens the boot stylesheet duplicates, and their aliases. */
const MIRRORED: Array<[boot: string, civitai: string]> = [
  ['--pn-boot-body', '--civitai-color-body'],
  ['--pn-boot-text', '--civitai-color-text'],
  ['--pn-boot-surface', '--civitai-color-surface'],
  ['--pn-boot-border', '--civitai-color-border'],
  ['--pn-boot-primary-light', '--civitai-color-primary-light'],
];

describe('boot token parity with @civitai/theme', () => {
  it('the DARK literals match the package [data-theme=dark] block', () => {
    for (const [boot, civitai] of MIRRORED) {
      expect(bootValue(':root', boot), boot).toBe(
        tokenValue(THEME_CSS, "[data-theme='dark']", civitai),
      );
    }
  });

  it('the LIGHT literals match the package :root block', () => {
    const media = BOOT_CSS.slice(BOOT_CSS.indexOf('@media (prefers-color-scheme: light)'));
    for (const [boot, civitai] of MIRRORED) {
      expect(tokenValue(media, ':root', boot), boot).toBe(
        tokenValue(THEME_CSS, ':root', civitai),
      );
    }
  });

  // 🔴 The load-bearing structural claim a colour-by-colour check cannot make: dark
  // must be what "no information" MEANS. A light value reachable without either the
  // media query or an explicit light signal would make a no-preference viewer boot
  // light while every other layer of this app resolves unknown to dark.
  it('no light value is reachable without an explicit light signal', () => {
    const lightBody = tokenValue(THEME_CSS, ':root', '--civitai-color-body');
    const darkBody = tokenValue(THEME_CSS, "[data-theme='dark']", '--civitai-color-body');
    expect(lightBody).not.toBe(darkBody); // sanity: or this test proves nothing

    expect(bootValue(':root', '--pn-boot-body')).toBe(darkBody);
    expect(bootValue(':root', '--pn-boot-body')).not.toBe(lightBody);

    expect(BOOT_CSS.indexOf('@media (prefers-color-scheme: light)')).toBeGreaterThan(-1);
    // No `@media (prefers-color-scheme: dark)` block: one would invert the default
    // for `no-preference` and for any UA without the query. Scoped to the
    // STYLESHEET — the claim is about rules, not a word in a comment.
    expect(BOOT_CSS).not.toContain('prefers-color-scheme: dark');
  });

  // 🔴 THIS EXISTS BECAUSE A MUTANT SURVIVED WITHOUT IT IN THE PILOT APP. The
  // `background` DECLARATION is not decoration: it paints the html canvas, the layer
  // beneath the skeleton. Flipping it to white changed nothing and no test failed.
  it('every html-canvas background matches its region', () => {
    const lightBody = tokenValue(THEME_CSS, ':root', '--civitai-color-body');
    const darkBody = tokenValue(THEME_CSS, "[data-theme='dark']", '--civitai-color-body');

    const baseHtml = BOOT_CSS.indexOf('html {');
    expect(baseHtml).toBeGreaterThan(-1);
    expect(/background:\s*([^;]+);/.exec(BOOT_CSS.slice(baseHtml))?.[1].trim().toLowerCase()).toBe(
      darkBody,
    );

    const mediaAt = BOOT_CSS.indexOf('@media (prefers-color-scheme: light)');
    expect(mediaAt).toBeGreaterThan(-1);
    expect(/background:\s*([^;]+);/.exec(BOOT_CSS.slice(mediaAt))?.[1].trim().toLowerCase()).toBe(
      lightBody,
    );

    // 🔴 NO `data-civitai-boot-theme` OVERRIDE BLOCKS IN THIS APP, deliberately —
    // index.html ships no inline fragment reader, so nothing ever sets that attribute
    // and asserting override rules here would pin markup that does not exist.
    //
    // 🔴 THE REASON IS NOT THE ONE THIS COMMENT USED TO GIVE. It said "its pinned SDK
    // cannot decode the init fragment" — true at 0.26.0, FALSE since the 0.42.0 bump,
    // and it survived two audit rounds here after the same sentence was corrected in
    // index.html and src/bootTheme.ts. What actually holds is that no reader has been
    // written yet. 🔴 SO THIS ASSERTION IS A SNAPSHOT, NOT AN INVARIANT: whoever ships
    // the reader and its CSS override blocks SHOULD delete it, not work around it.
    // 🔴 AND MUST EXTEND `MIRRORED` TO THE NEW REGION IN THE SAME CHANGE. Deleting
    // this line alone makes the suite green while leaving the override block's
    // literals asserted by NOTHING — measured: with the assertion gone, mutating
    // those literals to `#ff00ff` still reports 225/225. `MIRRORED` loops the base
    // `:root` and the media-query `:root` only, and this file's contract is every
    // literal checked against the installed @civitai/theme PER REGION.
    // See the note at the top of index.html for the order of work.
    expect(BOOT_CSS).not.toContain('data-civitai-boot-theme');
  });

  // `color-scheme` drives the UA canvas, which paints before ANY of the CSS above.
  // `light dark` — which this file shipped until 0.1.7 — would paint a
  // no-preference viewer's canvas white under a dark skeleton.
  it('the color-scheme meta lists dark first', () => {
    expect(INDEX_HTML).toContain('content="dark light"');
    expect(INDEX_HTML).not.toContain('content="light dark"');
  });

  // 🔴 THE HANDOFF SLOT. The app's own `#loadingEl` ("Connecting to host…", built in
  // <pano-app>#build()) is a `.pn-alert.pn-alert--info`, whose fill is
  // `--pn-surface-2` = a 4% mix of text into surface, with a 1px border. The boot
  // placeholder standing in for it must be the SAME box, or the moment the bundle
  // lands the viewer sees that one element change shade — the jump this whole change
  // exists to remove. The 12% mix used for the other bars is deliberately different
  // and must not leak into this rule.
  it('the alert placeholder is the same box the app`s loading element takes over', () => {
    const alert = block(BOOT_CSS, '[data-boot-skeleton] [data-boot-alert]');
    expect(alert).toContain('color-mix(in srgb, var(--pn-boot-text) 4%, var(--pn-boot-surface))');
    expect(alert).toContain('border: 1px solid var(--pn-boot-border)');
    // 13px text x 1.45 line-height, + 10px padding top and bottom, + 2px border.
    expect(alert).toContain('height: 41px');

    // The generic bars are the OTHER mix — if these two ever converge, the assertion
    // above stops distinguishing the alert slot from every other placeholder.
    const bar = block(BOOT_CSS, '[data-boot-skeleton] [data-boot-bar]');
    expect(bar).toContain('color-mix(in srgb, var(--pn-boot-text) 12%, var(--pn-boot-surface))');
    expect(bar).not.toContain('4%');
  });
});
