// <civitai-run-id> — the workflow id with click-to-copy, visible from the
// moment the id is known through every later phase: support and debugging
// depend on users being able to hand this id over.

import type { RunState } from '../types.js';
import { RunStateElement } from './base.js';

const FLASH_MS = 1500;

export class RunIdElement extends RunStateElement {
  #resetTimer: ReturnType<typeof setTimeout> | null = null;

  protected build(root: ShadowRoot): void {
    const row = document.createElement('div');
    row.className = 'row runid';
    row.innerHTML = `
      <span class="muted">Workflow</span>
      <code class="runid-value num" part="id"></code>
      <button type="button" class="runid-copy" part="copy">Copy</button>
    `;
    root.appendChild(row);
    row.querySelector('button')?.addEventListener('click', () => void this.#copy());
  }

  protected update(state: RunState): void {
    this.hidden = !state.workflowId;
    if (this.hidden) return;
    this.query<HTMLElement>('.runid-value').textContent = state.workflowId ?? '';
  }

  async #copy(): Promise<void> {
    const id = this.state.workflowId;
    if (!id) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(id);
      ok = true;
    } catch {
      // The Clipboard API is permission-gated in sandboxed iframes (the
      // production block sandbox) — fall back to a transient selection copy.
      const ta = document.createElement('textarea');
      ta.value = id;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
    }
    if (!ok) {
      // Leave the id selected so a manual Ctrl+C still works.
      window.getSelection()?.selectAllChildren(this.query('.runid-value'));
    }
    const btn = this.query<HTMLButtonElement>('.runid-copy');
    btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
    if (this.#resetTimer !== null) clearTimeout(this.#resetTimer);
    this.#resetTimer = setTimeout(() => {
      btn.textContent = 'Copy';
      this.#resetTimer = null;
    }, FLASH_MS);
  }
}
