// The three halves of `bootSkeleton: true` in a NON-REACT app, each of which can
// fail silently on its own:
//
//  1. THE SKELETON EXISTS AND IS INSIDE #root. With the manifest key set the host
//     stands down its veil, so an EMPTY `#root` means a blank iframe for the whole
//     load — strictly worse than not opting in.
//  2. SOMETHING REMOVES IT. 🔴 THIS IS WHAT MAKES THIS APP DIFFERENT FROM THE REACT
//     ONES IN THIS ROLLOUT. They mount with `createRoot(container).render(...)`,
//     which clears the container's children before its first commit, so their
//     skeletons delete themselves and they ship no cleanup code. This app APPENDS
//     (`root.appendChild(document.createElement('pano-app'))` in src/boot.ts), which
//     adds a sibling and removes nothing — an unremoved skeleton would sit above the
//     live app forever. `removeBootSkeleton()` is a mandatory, tested step, and the
//     test below drives the real `boot()` rather than re-implementing it.
//  3. THE PRE-`ready` PAINT AGREES WITH THE SKELETON — which is what makes the whole
//     thing worth doing, and where the SDK's `theme` sentinel bites.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// <pano-viewer> dynamically imports Photo Sphere Viewer (WebGL, which jsdom has
// none of). Mock it before the components load, exactly as pano-app.dom.test.ts does.
vi.mock('@photo-sphere-viewer/core', () => ({
  Viewer: class {
    constructor() {}
    addEventListener(): void {}
    async setPanorama(): Promise<void> {}
    destroy(): void {}
  },
}));

import type { BlockSnapshot } from '@civitai/blocks-react';

import { boot } from './boot.js';
import { bootThemeGuess, paintTheme, removeBootSkeleton } from './bootTheme.js';
import { registerElements } from './registry.js';
import type { PanoApp } from './components/pano-app.js';
import type { BlockSession } from './transport.js';

// 🔴 `process.cwd()`, not `import.meta.url`: under the jsdom project
// `import.meta.url` is an http URL (the `environmentOptions.jsdom.url` in
// vite.config.ts is the document base), so `new URL('../index.html', …)` is not a
// file URL and readFileSync rejects it with "URL must be of scheme file".
const INDEX_HTML = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

/**
 * The inline `<style>` body ONLY — never the raw file. index.html's comments discuss
 * these selectors in prose, and a comment is not a rule.
 */
const BOOT_CSS = (() => {
  const m = /<style>([\s\S]*?)<\/style>/.exec(INDEX_HTML);
  if (!m) throw new Error('no inline <style> found in index.html');
  return m[1];
})();

/**
 * Every declaration block whose SELECTOR mentions `[<attr>]`, concatenated.
 *
 * 🔴 Selector-aware, not a `"[attr] {"` string search. The animation rule groups
 * three selectors and only the LAST one is followed by the brace, so a naive needle
 * finds the pill's rule and reports the bar and alert as having no animation at all
 * — a false negative that made this suite's first version red at baseline. Innermost
 * `{…}` pairs are matched, which reaches rules nested inside an `@media` too.
 */
function rulesFor(attr: string): string {
  let out = '';
  for (const m of BOOT_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].includes(`[${attr}]`)) out += m[2];
  }
  return out;
}

/** The literal `#root` subtree as index.html ships it. */
function rootInnerHtml(): string {
  const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
  const root = doc.querySelector('#root');
  if (!root) throw new Error('could not extract #root from index.html');
  return root.innerHTML;
}

/**
 * A `<pano-app>` fed a fake host session, mounted the way <pano-app> mounts.
 *
 * `theme` here is what the SDK reports; `ready` is whether BLOCK_INIT has landed.
 * The pre-ready case deliberately passes the SDK's real sentinel value, `'light'`.
 */
function mountApp(snapshotOverrides: { ready: boolean; theme: string }): PanoApp {
  registerElements();
  const el = document.createElement('pano-app') as PanoApp;
  const snapshot = {
    ...snapshotOverrides,
    viewer: null,
    token: { scopes: [] },
  } as unknown as BlockSnapshot;
  el.session = {
    gateway: { submit: vi.fn(), poll: vi.fn(), cancel: vi.fn() },
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    canGenerate: () => false,
    estimate: vi.fn(),
    requestSignIn: vi.fn(),
    requestConsent: vi.fn(),
    getBuzzBalance: async () => null,
    openCheckpointPicker: async () => null,
    resize: vi.fn(),
  } as unknown as BlockSession;
  document.body.appendChild(el);
  return el;
}

// 🔴 THESE TESTS CONTROL THEIR OWN INPUTS, and both stubs are load-bearing.
//
// `matchMedia`: jsdom does not implement it at all, and src/test-setup.ts does not
// install one — but a future setup file that answered every query would silently
// decide "unknown resolves to dark" for us. In one app of this rollout exactly that
// happened and the dark-default test broke. Asking the question explicitly here is
// what makes the assertion about `bootThemeGuess()` rather than about a harness.
//
// The env var: `@civitai/blocks-react`'s IframeTransport THROWS out of its
// constructor unless an allowed parent origin is configured, and <pano-app>'s
// connectedCallback builds one via createBlockSession() when no session is injected.
// Custom-element reactions swallow that into an unhandled rejection rather than
// failing the append, so without this stub `boot()` would appear to work while the
// app never actually mounted. Stubbing it lets the transport construct while never
// receiving BLOCK_INIT — which is exactly the pre-`ready` state under test.
beforeEach(() => {
  vi.stubEnv('VITE_BLOCK_ALLOWED_PARENT_ORIGINS', 'https://civitai.com');
  vi.stubGlobal('matchMedia', ((query: string) => ({
    // OS says "not light" — i.e. dark or no-preference, the case the dark default
    // exists for. Individual tests override where they need the other answer.
    matches: /prefers-color-scheme: light/.test(query) ? false : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia);
});

afterEach(() => {
  document.documentElement.removeAttribute('data-civitai-boot-theme');
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '';
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the shipped index.html', () => {
  it('puts a non-empty boot skeleton INSIDE #root', () => {
    const host = document.createElement('div');
    host.innerHTML = rootInnerHtml();

    // 🔴 Emptiness is what the platform gate keys on, and a container holding only
    // an inert node still reads as "non-empty" to a naive check — a `<script>`'s
    // source IS a text node. Strip inert subtrees before testing.
    host.querySelectorAll('script, style, template').forEach((n) => n.remove());
    expect(host.textContent?.trim() ?? '').toBe(''); // no copy to translate…
    expect(host.children.length).toBeGreaterThan(0); // …but real painted boxes

    const marker = host.querySelector('[data-boot-skeleton]');
    expect(marker).not.toBeNull();
    expect(marker!.getAttribute('aria-hidden')).toBe('true');
  });

  // 🔴 PARSED, not grepped. A substring check for `data-boot-skeleton` outside the
  // #root region is walkable: the inline <style> mentions `[data-boot-skeleton]` as
  // a SELECTOR, which is legitimate and is not an element. The invariant is about
  // element PLACEMENT, so it has to be asserted against a DOM.
  it('has every [data-boot-skeleton] ELEMENT inside #root', () => {
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
    const root = doc.querySelector('#root');
    expect(root).not.toBeNull();

    const marked = [...doc.querySelectorAll('[data-boot-skeleton]')];
    expect(marked.length).toBeGreaterThan(0); // positive control: the query CAN match
    for (const el of marked) expect(root!.contains(el)).toBe(true);
  });

  // 🔴 THIS TEST EXISTS BECAUSE A MUTANT SURVIVED WITHOUT IT — found by probing this
  // suite's own coverage rather than by review. `style="display:none"` on the
  // skeleton's card left every other assertion green: the marker element is still
  // there, still inside #root, still aria-hidden, and #root still has a child. But a
  // skeleton that paints NOTHING is exactly the state `bootSkeleton: true` makes
  // worse than not opting in — the host's veil is down over a blank iframe either
  // way, so "the markup exists" is not the invariant. Visible painted area is.
  //
  // jsdom has no layout, so this cannot measure pixels. It asserts the two
  // structural facts that stand in for them: enough boxes, and each of them actually
  // given a fill by the inline stylesheet, with nothing hidden by inline style or by
  // a rule.
  it('paints real boxes — not an empty, hidden, or unfilled shell', () => {
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
    const marker = doc.querySelector('#root [data-boot-skeleton]');
    expect(marker).not.toBeNull();

    const subtree = [marker!, ...marker!.querySelectorAll('*')];
    expect(subtree.length).toBeGreaterThanOrEqual(8);

    // 🔴 AN ALLOWLIST, NOT A DENYLIST — and that distinction was found the hard way.
    // The first version of this check banned `display:none`, `visibility:hidden` and
    // `opacity:0` by name, and a mutant that wrapped the interior in a plain
    // `<div hidden>` walked straight through it: enumerating the ways to hide
    // something is an unwinnable list (`hidden`, `content-visibility`,
    // `transform: scale(0)`, `height: 0; overflow: hidden`, …). The shipped skeleton
    // only ever needs inline GEOMETRY, so state that instead: any other inline
    // property, and any `hidden` attribute, fails regardless of what it spells.
    for (const el of subtree) {
      const where = el.outerHTML.slice(0, 90);
      expect(el.hasAttribute('hidden'), where).toBe(false);
      const props = (el.getAttribute('style') ?? '')
        .split(';')
        .map((d) => d.split(':')[0].trim().toLowerCase())
        .filter(Boolean);
      for (const p of props) expect(['height', 'width'], `${where} → ${p}`).toContain(p);
    }

    // The stylesheet half of the same hazard. Still a denylist — a rule can hide a
    // box in ways this pattern does not name, and jsdom has no layout to settle it
    // with — so this catches the blunt spellings only. Recorded as a known bound.
    expect(BOOT_CSS).not.toMatch(
      /\[data-boot-[a-z-]*\][^{}]*\{[^}]*(display:\s*none|visibility:\s*hidden|opacity:\s*0\b)/,
    );

    // Boxes the stylesheet actually gives a fill to. A placeholder with no
    // `background` is an invisible rectangle — present in the DOM, absent on screen.
    const filled = subtree.filter((el) =>
      [...el.attributes].some(
        (a) => a.name.startsWith('data-boot-') && /background:/.test(rulesFor(a.name)),
      ),
    );
    expect(filled.length).toBeGreaterThanOrEqual(5);
  });

  // 🔴 ALSO A SURVIVED MUTANT: breaking the media feature name left the suite green.
  // The skeleton's pulse runs for the whole load, so honouring the reduced-motion
  // preference is a real contract and nothing else in this repo asserts it. The
  // artifact under test here IS css text, so the guard pins the normalised
  // declaration rather than a word that could be spelled elsewhere.
  it('honours prefers-reduced-motion', () => {
    const at = BOOT_CSS.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(at).toBeGreaterThan(-1);
    const body = BOOT_CSS.slice(at, BOOT_CSS.indexOf('\n      }', at));
    expect(body.replace(/\s+/g, ' ')).toContain('animation: none;');
    // …and it covers every animated placeholder, not just one of them.
    for (const attr of ['data-boot-bar', 'data-boot-alert', 'data-boot-pill']) {
      expect(body, attr).toContain(`[${attr}]`);
      expect(rulesFor(attr), attr).toContain('animation: pn-boot-pulse');
    }
  });
});

describe('boot() takes the skeleton down — this app APPENDS, so nothing else will', () => {
  /** `#root` in the document, seeded with the REAL markup index.html ships. */
  function seedRoot(): HTMLElement {
    const root = document.createElement('div');
    root.id = 'root';
    root.innerHTML = rootInnerHtml();
    document.body.appendChild(root);
    return root;
  }

  it('mounts <pano-app> and removes the skeleton', async () => {
    const root = seedRoot();
    expect(root.querySelector('[data-boot-skeleton]')).not.toBeNull();

    await boot();

    // 🔴 The card, not merely the element. `document.createElement('pano-app')` +
    // appendChild produces a node even when connectedCallback throws — jsdom turns a
    // custom-element reaction's throw into an unhandled error and appends anyway. So
    // asserting the ELEMENT exists would go green over a mount that failed outright.
    // `.pn-card` only exists if #build() ran to completion.
    expect(root.querySelector('pano-app .pn-card')).not.toBeNull();
    expect(root.querySelector('[data-boot-skeleton]')).toBeNull();
    // Nothing else went with it: the app is the only child left.
    expect(root.children.length).toBe(1);
  });

  // 🔴 THE ORDER IS THE DEFECT-PREVENTING PART, not an implementation detail. If the
  // removal ran BEFORE the append, #root would be empty for the width of that gap —
  // and with the host's veil stood down by `bootSkeleton: true`, an empty #root is a
  // visible flash rather than a hidden one. Asserted by watching the DOM: #root must
  // never be observed childless between the two operations.
  it('never leaves #root empty between the two operations', async () => {
    const root = seedRoot();

    // 🔴 REPLAY THE RECORDS, do not read `root.children` in the callback. A
    // MutationObserver batches and fires ONCE, after every mutation has landed — so
    // a callback that inspects the live DOM always sees the final state (one child)
    // and the test would be vacuous, passing whatever the order was. Reconstructing
    // the child count step by step from the records is what makes the intermediate
    // state observable at all.
    let count = root.children.length;
    expect(count).toBe(1); // the skeleton, before anything runs
    const sequence: number[] = [count];
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.removedNodes) if (n.nodeType === 1) count -= 1;
        for (const n of r.addedNodes) if (n.nodeType === 1) count += 1;
        sequence.push(count);
      }
    });
    observer.observe(root, { childList: true });

    await boot();
    await new Promise((r) => setTimeout(r, 0)); // let the observer drain
    observer.disconnect();

    // Positive control: the observer DID see the swap. Without this a wiring
    // failure would leave `sequence` at its initial value and read as a pass.
    expect(sequence.length).toBeGreaterThan(1);
    expect(sequence).not.toContain(0);
    expect(count).toBe(1); // and the app is what is left standing
  });

  it('is idempotent, so a second sweep cannot strip the app', async () => {
    const root = seedRoot();
    await boot();
    removeBootSkeleton(root);
    expect(root.querySelector('pano-app .pn-card')).not.toBeNull();
  });

  it('removes EVERY marked node, not just the first', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-boot-skeleton><i></i></div><div data-boot-skeleton><i></i></div><p id="keep"></p>';
    removeBootSkeleton(root);
    expect(root.querySelectorAll('[data-boot-skeleton]').length).toBe(0);
    expect(root.querySelector('#keep')).not.toBeNull();
  });

  it('is scoped to the root it is given', () => {
    const outside = document.createElement('div');
    outside.innerHTML = '<div data-boot-skeleton></div>';
    document.body.appendChild(outside);

    const root = document.createElement('div');
    root.innerHTML = '<div data-boot-skeleton></div>';
    removeBootSkeleton(root);

    expect(root.querySelector('[data-boot-skeleton]')).toBeNull();
    expect(outside.querySelector('[data-boot-skeleton]')).not.toBeNull();
  });
});

describe('the pre-ready paint agrees with the skeleton', () => {
  // 🔴 THE POINT OF THE WHOLE CHANGE. Before BLOCK_INIT the SDK's snapshot reports
  // `ready: false` and the hardcoded sentinel `theme: 'light'`. Stamping that
  // sentinel — which the old `snapshot.theme === 'light' ? 'light' : 'dark'` line
  // did, while READING as a dark default — repaints the dark boot skeleton light and
  // then dark again ~100ms later: a flash INTRODUCED by standing the host's veil down.
  it('paints DARK before ready, even though the SDK sentinel says light', () => {
    mountApp({ ready: false, theme: 'light' });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('honours a light answer recorded on the boot attribute', () => {
    document.documentElement.setAttribute('data-civitai-boot-theme', 'light');
    mountApp({ ready: false, theme: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  // After BLOCK_INIT the host is authoritative — including when it really is light.
  it('hands over to the host theme once ready', () => {
    mountApp({ ready: true, theme: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('still stamps dark when the ready host says dark', () => {
    mountApp({ ready: true, theme: 'dark' });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('bootTheme helpers', () => {
  it('reads the attribute back rather than re-deriving it', () => {
    document.documentElement.setAttribute('data-civitai-boot-theme', 'light');
    expect(bootThemeGuess()).toBe('light');
    document.documentElement.setAttribute('data-civitai-boot-theme', 'dark');
    expect(bootThemeGuess()).toBe('dark');
  });

  it('resolves an absent or junk attribute to dark', () => {
    expect(bootThemeGuess()).toBe('dark');
    document.documentElement.setAttribute('data-civitai-boot-theme', 'chartreuse');
    expect(bootThemeGuess()).toBe('dark');
  });

  // The positive half: the OS query is asked, and a real light preference is honoured.
  // Without this the dark default could be a stuck constant rather than an answer.
  it('honours an OS light preference', () => {
    vi.stubGlobal('matchMedia', ((query: string) => ({
      matches: /prefers-color-scheme: light/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia);
    expect(bootThemeGuess()).toBe('light');
  });

  // 🔴 THESE TWO EXIST BECAUSE A MUTANT SURVIVED WITHOUT THEM IN EVERY APP OF THIS
  // ROLLOUT. Flipping the function's final `return 'dark'` to `'light'` changed
  // nothing and no test failed — correctly, because every other test either sets the
  // attribute or has a working `matchMedia` stub, so the last-resort return was
  // never reached. It IS reachable in production: a UA without `matchMedia`, or a
  // hardened embedder where touching it throws.
  it('resolves DARK when matchMedia is unavailable entirely', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(bootThemeGuess()).toBe('dark');
  });

  it('resolves DARK when matchMedia throws', () => {
    vi.stubGlobal('matchMedia', (() => {
      throw new Error('blocked');
    }) as unknown as typeof window.matchMedia);
    expect(bootThemeGuess()).toBe('dark');
  });

  it('gates the host theme on ready', () => {
    document.documentElement.setAttribute('data-civitai-boot-theme', 'dark');
    expect(paintTheme(true, 'light')).toBe('light');
    expect(paintTheme(false, 'light')).toBe('dark');
    // A ready host that reports no theme at all still gets the guess, not undefined.
    expect(paintTheme(true, undefined)).toBe('dark');
  });
});
