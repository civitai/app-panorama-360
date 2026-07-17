// <civitai-run-logs> — the worker's console output (trace `logs` frames),
// collapsed by default behind a "Show logs" toggle; tails to the bottom while
// open. Build-once so toggling state survives the tick-rate updates.

import type { RunState } from '../types.js';
import { RunStateElement } from './base.js';

export class RunLogsElement extends RunStateElement {
  protected build(root: ShadowRoot): void {
    const details = document.createElement('details');
    details.className = 'logs';
    details.innerHTML = `
      <summary part="toggle">Show logs <span class="count muted num"></span></summary>
      <pre class="log-body" part="body"></pre>
    `;
    root.appendChild(details);
    details.addEventListener('toggle', () => {
      const summary = details.querySelector('summary');
      if (summary?.firstChild) {
        summary.firstChild.textContent = details.open ? 'Hide logs ' : 'Show logs ';
      }
    });
  }

  protected update(state: RunState): void {
    this.hidden = state.logs.length === 0;
    if (this.hidden) return;

    this.query<HTMLElement>('.count').textContent = `(${state.logs.length})`;
    const pre = this.query<HTMLPreElement>('pre.log-body');
    const text = state.logs.join('\n');
    if (pre.textContent !== text) {
      pre.textContent = text;
      const details = this.query<HTMLDetailsElement>('details.logs');
      if (details.open) pre.scrollTop = pre.scrollHeight;
    }
  }
}
