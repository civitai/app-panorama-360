// <civitai-comfy-run> — the composite: give it a RunController (or push
// RunState by property) and it projects the state into status, buzz meter,
// live preview, and logs. The status element's cancel event is composed, so
// it bubbles out of this element for the app to handle.

import type { RunController } from '../run-controller.js';
import { INITIAL_RUN_STATE, type RunState } from '../types.js';
import { adoptStyles } from './styles.js';
import type { RunStateElement } from './base.js';

const CHILDREN = [
  'civitai-run-status',
  'civitai-buzz-meter',
  'civitai-run-preview',
  'civitai-run-logs',
] as const;

export class ComfyRunElement extends HTMLElement {
  #controller: RunController | null = null;
  #unsubscribe: (() => void) | null = null;
  #state: RunState = INITIAL_RUN_STATE;
  #built = false;

  get controller(): RunController | null {
    return this.#controller;
  }

  set controller(controller: RunController | null) {
    this.#detach();
    this.#controller = controller;
    if (this.isConnected) this.#attach();
  }

  get state(): RunState {
    return this.#state;
  }

  /** Direct state projection for controller-less (dumb) usage. */
  set state(value: RunState) {
    this.#state = value;
    this.#project();
  }

  connectedCallback(): void {
    if (!this.#built) {
      const root = this.attachShadow({ mode: 'open' });
      adoptStyles(root);
      const wrap = document.createElement('div');
      wrap.style.display = 'grid';
      wrap.style.gap = '8px';
      for (const tag of CHILDREN) wrap.appendChild(document.createElement(tag));
      root.appendChild(wrap);
      this.#built = true;
    }
    this.#attach();
  }

  disconnectedCallback(): void {
    this.#detach();
  }

  #attach(): void {
    if (this.#controller) {
      this.#state = this.#controller.getState();
      this.#unsubscribe = this.#controller.subscribe((state) => {
        this.#state = state;
        this.#project();
      });
    }
    this.#project();
  }

  #detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #project(): void {
    if (!this.#built) return;
    for (const tag of CHILDREN) {
      const child = this.shadowRoot?.querySelector(tag) as RunStateElement | null;
      if (child) child.state = this.#state;
    }
  }
}
