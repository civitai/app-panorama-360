// Shared shadow stylesheet. Themable via `--crk-*` custom properties (they
// inherit through shadow boundaries, so a light-DOM consumer themes the kit
// with one plain CSS rule); every var has a neutral-light fallback.

const CSS = `
:host {
  display: block;
  color: var(--crk-text, inherit);
  font-family: var(--crk-font, inherit);
  font-size: 13px;
  line-height: 1.5;
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
.card {
  background: var(--crk-surface, #f8f9fa);
  border: 1px solid var(--crk-border, #dee2e6);
  border-radius: 8px;
  padding: 10px 12px;
  display: grid;
  gap: 8px;
}
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.grow { flex: 1; }
.muted { color: var(--crk-muted, #868e96); font-size: 12px; }
.num { font-variant-numeric: tabular-nums; }
.spinner {
  width: 13px; height: 13px; border-radius: 50%; flex: none;
  border: 2px solid var(--crk-border, #dee2e6);
  border-top-color: var(--crk-accent, #0b7285);
  animation: crk-spin 0.9s linear infinite;
}
@keyframes crk-spin { to { transform: rotate(360deg); } }
.bar {
  position: relative; height: 6px; border-radius: 999px;
  background: var(--crk-border, #dee2e6);
  overflow: hidden;
}
.bar-fill {
  position: absolute; top: 0; bottom: 0; left: 0; width: 0%;
  background: var(--crk-accent, #0b7285);
  border-radius: inherit;
  transition: width 0.25s linear;
}
.bar.indeterminate .bar-fill { width: 30%; animation: crk-slide 1.2s ease-in-out infinite; }
@keyframes crk-slide { 0% { left: -30%; } 100% { left: 100%; } }
button.cancel {
  padding: 5px 12px; border-radius: 6px;
  border: 1px solid var(--crk-danger, #c92a2a);
  background: transparent; color: var(--crk-danger, #c92a2a);
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
button.cancel:disabled { opacity: 0.55; cursor: not-allowed; }
button.cancel:focus-visible { outline: 2px solid var(--crk-accent, #0b7285); outline-offset: 1px; }
pre {
  margin: 0; padding: 8px;
  background: var(--crk-code-bg, rgba(0, 0, 0, 0.05));
  border-radius: 6px;
  font-size: 11px; line-height: 1.45;
  max-height: 200px; overflow: auto;
  white-space: pre-wrap; word-break: break-word;
}
details > summary { cursor: pointer; font-weight: 600; font-size: 12px; }
.runid { font-size: 11px; }
.runid-value {
  font-size: 11px; user-select: all;
  background: var(--crk-code-bg, rgba(0, 0, 0, 0.05));
  padding: 1px 6px; border-radius: 4px;
}
button.runid-copy {
  padding: 1px 8px; border-radius: 4px;
  border: 1px solid var(--crk-border, #dee2e6);
  background: transparent; color: var(--crk-muted, #868e96);
  font: inherit; font-size: 11px; cursor: pointer;
}
button.runid-copy:focus-visible { outline: 2px solid var(--crk-accent, #0b7285); outline-offset: 1px; }
img.preview {
  display: block; width: 100%; border-radius: 6px;
  border: 1px solid var(--crk-border, #dee2e6);
}
`;

let sheet: CSSStyleSheet | null = null;

export function adoptStyles(root: ShadowRoot): void {
  try {
    if (sheet === null) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
    }
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
  }
}
