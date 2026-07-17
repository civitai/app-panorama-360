// <pano-status> — app-level alerts + the kit's <civitai-comfy-run> card.
// Built once: rebuilding the run element would reset its logs toggle.

import { INITIAL_RUN_STATE } from '@civitai/comfy-run-kit';
import type { ComfyRunElement } from '@civitai/comfy-run-kit/elements';

import type { ControllerState } from '../controller.js';
import { formatCost, spentAccountLabel } from '../generation.js';

/** Phases whose surface is the kit run card (state.run drives it). */
const RUN_PHASES = new Set(['submitting', 'polling', 'failed', 'canceled']);

export class PanoStatus extends HTMLElement {
  #state: ControllerState | null = null;
  #alerts!: HTMLElement;
  #run!: ComfyRunElement;
  #note!: HTMLElement;

  set state(value: ControllerState) {
    this.#state = value;
    this.#render();
  }

  connectedCallback(): void {
    if (this.#alerts) return;
    this.#alerts = document.createElement('div');
    this.#alerts.className = 'pn-field';
    this.#run = document.createElement('civitai-comfy-run');
    this.#run.hidden = true;
    this.#note = document.createElement('div');
    this.#note.className = 'pn-muted';
    this.#note.hidden = true;
    this.append(this.#alerts, this.#run, this.#note);
    this.#render();
  }

  #render(): void {
    const state = this.#state;
    if (!this.#alerts || !state) return;

    this.#alerts.textContent = '';

    const showRun = !!state.run && RUN_PHASES.has(state.phase);
    this.#run.hidden = !showRun;
    this.#run.state = showRun && state.run ? state.run : INITIAL_RUN_STATE;

    const busy = state.phase === 'submitting' || state.phase === 'polling';
    this.#note.hidden = !busy;
    if (busy) {
      this.#note.textContent =
        '1 Buzz per GPU second — typically 30–90 per panorama. Cancel anytime; you only pay for time used.';
    }

    switch (state.phase) {
      case 'estimating': {
        const row = document.createElement('div');
        row.className = 'pn-phase';
        const spinner = document.createElement('span');
        spinner.className = 'pn-spinner';
        const label = document.createElement('span');
        label.textContent = 'Estimating cost…';
        row.append(spinner, label);
        this.#alerts.appendChild(row);
        break;
      }
      case 'needs-consent':
        this.#alerts.appendChild(
          alertEl('info', 'Confirm in the Civitai dialog to allow budgeted Buzz spend. If you dismissed it, click Generate again.'),
        );
        break;
      case 'succeeded': {
        const note = spentAccountLabel(state.spentAccountType ?? undefined);
        this.#alerts.appendChild(
          alertEl(
            'success',
            `Done — spent ${formatCost(state.actualCost)} Buzz${note ? ` from your ${note} account` : ''}. Drag the panorama to look around.`,
          ),
        );
        break;
      }
      case 'insufficient':
        this.#alerts.appendChild(
          alertEl('warning', 'Not enough Buzz — top up your balance and try again.'),
        );
        break;
      case 'account-rejected':
        this.#alerts.appendChild(
          alertEl('warning', "That Buzz account can't fund this app's content rating — try again with Auto."),
        );
        break;
      case 'failed':
        // With a run, the kit card carries the message + traceback; the alert
        // covers estimate-path failures that never started a run.
        if (!state.run) this.#alerts.appendChild(alertEl('error', state.error ?? 'Generation failed.'));
        break;
      case 'canceled':
        // An orchestrator-side cancel with nothing billed is the "stopped
        // before it started" case (e.g. a just-captured custom-node layer not
        // resolvable yet) — a plain retry usually lands.
        if (state.run?.canceledReason === 'unknown') {
          this.#alerts.appendChild(
            alertEl('info', 'The orchestrator stopped this run before it started — this can happen right after the custom nodes are first captured. Try Generate again.'),
          );
        }
        break;
      case 'polling':
        if (state.imageUrl) {
          this.#alerts.appendChild(alertEl('info', 'First image is in — still finishing up.'));
        }
        break;
    }
  }
}

function alertEl(kind: 'info' | 'success' | 'warning' | 'error', text: string): HTMLElement {
  const node = document.createElement('div');
  node.className = `pn-alert pn-alert--${kind}`;
  node.dataset.testid = `pn-alert-${kind}`;
  node.textContent = text;
  return node;
}
