// Build-once base for the run elements: the shadow DOM is constructed a single
// time and `update()` patches it on every state set — re-rendering innerHTML
// would reset <details> open state and button focus at the 4 Hz tick rate.

import { INITIAL_RUN_STATE, type RunState } from '../types.js';
import { adoptStyles } from './styles.js';

export abstract class RunStateElement extends HTMLElement {
  #state: RunState = INITIAL_RUN_STATE;
  #built = false;

  get state(): RunState {
    return this.#state;
  }

  set state(value: RunState) {
    this.#state = value;
    if (this.#built) this.update(value);
  }

  connectedCallback(): void {
    let root = this.shadowRoot;
    if (!root) {
      root = this.attachShadow({ mode: 'open' });
      adoptStyles(root);
    }
    if (!this.#built) {
      this.build(root);
      this.#built = true;
    }
    this.update(this.#state);
  }

  protected query<T extends Element>(selector: string): T {
    const el = this.shadowRoot?.querySelector<T>(selector);
    if (!el) throw new Error(`missing element: ${selector}`);
    return el;
  }

  protected abstract build(root: ShadowRoot): void;
  protected abstract update(state: RunState): void;
}
