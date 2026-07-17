// <civitai-run-status> — phase label, unified progress bar (download % while
// preparing, sampler % while running, indeterminate otherwise), queue line,
// current node, elapsed time, and the cancel button (emits RUN_CANCEL_EVENT,
// composed so it crosses shadow boundaries).

import type { RunState } from '../types.js';
import { RunStateElement } from './base.js';

export const RUN_CANCEL_EVENT = 'civitai-run-cancel';

const BUSY_PHASES = new Set(['submitting', 'queued', 'preparing', 'starting', 'running']);

function phaseLabel(state: RunState): string {
  switch (state.phase) {
    case 'submitting':
      return 'Submitting…';
    case 'queued':
      return state.queue && state.queue.ahead > 0
        ? `Queued — ${state.queue.ahead} job${state.queue.ahead === 1 ? '' : 's'} ahead`
        : 'Queued…';
    case 'preparing': {
      const pct = state.prepProgress !== null ? ` ${Math.round(state.prepProgress * 100)}%` : '…';
      return `Preparing — downloading models${pct}`;
    }
    case 'starting':
      return 'Starting up…';
    case 'running':
      if (state.sampler) return `Rendering — step ${state.sampler.step}/${state.sampler.total}`;
      // Pre-sampler execution is model loading etc. — say what's actually
      // happening rather than overstating with "Rendering".
      return state.currentNode ? `${state.currentNode}…` : 'Running…';
    case 'succeeded':
      return '✓ Done';
    case 'failed':
      return '✗ Failed';
    case 'canceled':
      return state.canceledReason === 'outOfBuzz' ? '■ Stopped' : '■ Canceled';
    default:
      return '';
  }
}

function subLabel(state: RunState): string {
  if (state.phase === 'queued' && state.queue?.etaStart) {
    const eta = new Date(state.queue.etaStart);
    if (!Number.isNaN(eta.getTime())) {
      return `Estimated start ${eta.toLocaleTimeString()}`;
    }
  }
  if (state.phase === 'running' && state.sampler && state.currentNode) return state.currentNode;
  if (state.phase === 'succeeded' && state.settled?.total != null) {
    return `${state.settled.total} Buzz · ${state.elapsedSeconds}s`;
  }
  if (state.phase === 'failed' && state.error) return state.error.message;
  if (state.phase === 'canceled') {
    return state.canceledReason === 'outOfBuzz'
      ? 'You likely ran out of Buzz — billed only for the GPU time used.'
      : state.canceledReason === 'user'
        ? 'Billed only for the GPU time used.'
        : '';
  }
  return '';
}

export class RunStatusElement extends RunStateElement {
  protected build(root: ShadowRoot): void {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="row">
        <span class="spinner" part="spinner"></span>
        <span class="label grow" part="label"></span>
        <span class="elapsed muted num" part="elapsed"></span>
        <button class="cancel" part="cancel" type="button">Cancel</button>
      </div>
      <div class="bar" part="bar"><div class="bar-fill"></div></div>
      <div class="sub muted" part="sub"></div>
      <details class="traceback" part="traceback">
        <summary>Error details</summary>
        <pre></pre>
      </details>
    `;
    root.appendChild(card);
    card.querySelector('button.cancel')?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent(RUN_CANCEL_EVENT, { bubbles: true, composed: true }));
    });
  }

  protected update(state: RunState): void {
    this.hidden = state.phase === 'idle';
    if (this.hidden) return;

    const busy = BUSY_PHASES.has(state.phase);

    this.query<HTMLElement>('.spinner').hidden = !busy;
    this.query<HTMLElement>('.label').textContent = phaseLabel(state);
    const elapsed = this.query<HTMLElement>('.elapsed');
    elapsed.hidden = !busy;
    elapsed.textContent = `${state.elapsedSeconds}s`;

    const cancel = this.query<HTMLButtonElement>('button.cancel');
    cancel.hidden = !busy || !state.workflowId;
    cancel.disabled = state.cancelPending;
    cancel.textContent = state.cancelPending ? 'Canceling…' : 'Cancel';

    const bar = this.query<HTMLElement>('.bar');
    const fill = this.query<HTMLElement>('.bar-fill');
    bar.hidden = !busy;
    if (busy) {
      const pct =
        state.phase === 'preparing' && state.prepProgress !== null
          ? Math.round(state.prepProgress * 100)
          : state.phase === 'running' && state.sampler
            ? state.sampler.pct
            : null;
      bar.classList.toggle('indeterminate', pct === null);
      fill.style.width = pct === null ? '' : `${pct}%`;
    }

    const sub = this.query<HTMLElement>('.sub');
    const subText = subLabel(state);
    sub.hidden = subText.length === 0;
    sub.textContent = subText;

    const traceback = this.query<HTMLDetailsElement>('details.traceback');
    const hasTraceback = state.phase === 'failed' && !!state.error?.traceback;
    traceback.hidden = !hasTraceback;
    if (hasTraceback) {
      const pre = traceback.querySelector('pre');
      if (pre && pre.textContent !== state.error?.traceback) {
        pre.textContent = state.error?.traceback ?? '';
      }
    }
  }
}
