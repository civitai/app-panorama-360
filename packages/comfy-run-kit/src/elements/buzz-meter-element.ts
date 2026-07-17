// <civitai-buzz-meter> — the live ⚡ cost of the run. Ticks with the
// controller's extrapolation while running, snaps to the settled total (and
// itemizes the per-wallet transactions) at terminal.

import type { RunState } from '../types.js';
import { RunStateElement } from './base.js';

export class BuzzMeterElement extends RunStateElement {
  protected build(root: ShadowRoot): void {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="row">
        <span aria-hidden="true">⚡</span>
        <span class="amount num grow" part="amount"></span>
        <span class="rate muted num" part="rate"></span>
      </div>
      <div class="tx muted" part="transactions"></div>
    `;
    root.appendChild(card);
  }

  protected update(state: RunState): void {
    const { buzz, settled } = state;
    this.hidden = buzz.live === null && !buzz.settled;
    if (this.hidden) return;

    const amount = this.query<HTMLElement>('.amount');
    amount.textContent = buzz.settled
      ? `${settled?.total ?? buzz.live ?? 0} Buzz`
      : `~${buzz.live ?? 0} Buzz so far`;

    const rate = this.query<HTMLElement>('.rate');
    rate.hidden = buzz.settled || buzz.rate === null;
    rate.textContent = buzz.rate !== null ? `${buzz.rate} Buzz/s` : '';

    const tx = this.query<HTMLElement>('.tx');
    const items = buzz.settled ? (settled?.transactions ?? []) : [];
    tx.hidden = items.length === 0;
    tx.textContent = items
      .filter((t) => typeof t.amount === 'number')
      .map((t) => `${t.accountType ?? 'buzz'}: ${t.amount}`)
      .join(' · ');
  }
}
