import { beforeAll, describe, expect, it, vi } from 'vitest';

import { RUN_CANCEL_EVENT, registerRunElements } from '../elements.js';
import type { RunController } from '../run-controller.js';
import { INITIAL_RUN_STATE, type RunState } from '../types.js';

const state = (over: Partial<RunState>): RunState => ({ ...INITIAL_RUN_STATE, ...over });

const running = (over: Partial<RunState> = {}): RunState =>
  state({
    phase: 'running',
    workflowId: 'wf_1',
    startedAt: Date.now(),
    elapsedSeconds: 21,
    sampler: { step: 12, total: 30, pct: 40 },
    buzz: { live: 21, rate: 1, settled: false },
    ...over,
  });

function mount<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  return el;
}

const shadowText = (el: HTMLElement) => el.shadowRoot?.textContent ?? '';

beforeAll(() => {
  registerRunElements();
  registerRunElements(); // idempotent
});

describe('<civitai-run-status>', () => {
  it('hides when idle', () => {
    const el = mount('civitai-run-status');
    el.state = state({ phase: 'idle' });
    expect(el.hidden).toBe(true);
  });

  it('shows sampler progress with a determinate bar while running', () => {
    const el = mount('civitai-run-status');
    el.state = running();
    expect(shadowText(el)).toContain('Rendering — step 12/30');
    expect(shadowText(el)).toContain('21s');
    const bar = el.shadowRoot!.querySelector('.bar')!;
    expect(bar.classList.contains('indeterminate')).toBe(false);
    expect((bar.querySelector('.bar-fill') as HTMLElement).style.width).toBe('40%');
  });

  it('running without sampler names the executing node, not "Rendering"', () => {
    const el = mount('civitai-run-status');
    el.state = running({ sampler: null, currentNode: 'Loading checkpoint' });
    expect(shadowText(el)).toContain('Loading checkpoint…');
    expect(shadowText(el)).not.toContain('Rendering');
  });

  it('shows queue position, and download % while preparing', () => {
    const el = mount('civitai-run-status');
    el.state = state({
      phase: 'queued',
      workflowId: 'wf_1',
      queue: { ahead: 2, etaStart: null },
    });
    expect(shadowText(el)).toContain('2 jobs ahead');
    expect(el.shadowRoot!.querySelector('.bar')!.classList.contains('indeterminate')).toBe(true);

    el.state = state({ phase: 'preparing', workflowId: 'wf_1', prepProgress: 0.42 });
    expect(shadowText(el)).toContain('downloading models 42%');
    expect(
      (el.shadowRoot!.querySelector('.bar-fill') as HTMLElement).style.width,
    ).toBe('42%');
  });

  it('cancel button emits the composed cancel event and reflects cancelPending', () => {
    const el = mount('civitai-run-status');
    el.state = running();
    const heard = vi.fn();
    document.addEventListener(RUN_CANCEL_EVENT, heard);
    const button = el.shadowRoot!.querySelector<HTMLButtonElement>('button.cancel')!;
    expect(button.hidden).toBe(false);
    button.click();
    expect(heard).toHaveBeenCalledTimes(1);

    el.state = running({ cancelPending: true });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Canceling…');
    document.removeEventListener(RUN_CANCEL_EVENT, heard);
  });

  it('renders terminal outcomes: out-of-buzz stop and failure traceback', () => {
    const el = mount('civitai-run-status');
    el.state = state({ phase: 'canceled', canceledReason: 'outOfBuzz' });
    expect(shadowText(el)).toContain('Stopped');
    expect(shadowText(el)).toContain('ran out of Buzz');

    el.state = state({
      phase: 'failed',
      error: { message: 'node exploded', traceback: 'Traceback: kaboom' },
    });
    expect(shadowText(el)).toContain('node exploded');
    const details = el.shadowRoot!.querySelector<HTMLDetailsElement>('details.traceback')!;
    expect(details.hidden).toBe(false);
    expect(details.querySelector('pre')!.textContent).toBe('Traceback: kaboom');
  });
});

describe('<civitai-buzz-meter>', () => {
  it('hides without data, ticks live, settles with transactions', () => {
    const el = mount('civitai-buzz-meter');
    el.state = state({});
    expect(el.hidden).toBe(true);

    el.state = running();
    expect(el.hidden).toBe(false);
    expect(shadowText(el)).toContain('~21 Buzz so far');
    expect(shadowText(el)).toContain('1 Buzz/s');

    el.state = state({
      phase: 'succeeded',
      buzz: { live: 45, rate: 1, settled: true },
      settled: {
        total: 45,
        transactions: [{ accountType: 'yellow', amount: -45 }],
        spentAccountType: 'yellow',
      },
    });
    expect(shadowText(el)).toContain('45 Buzz');
    expect(shadowText(el)).toContain('yellow: -45');
  });
});

describe('<civitai-run-preview>', () => {
  it('shows the live preview only while in flight', () => {
    const el = mount('civitai-run-preview');
    el.state = running({ previewUrl: 'blob:preview-1' });
    expect(el.hidden).toBe(false);
    expect(el.shadowRoot!.querySelector('img')!.getAttribute('src')).toBe('blob:preview-1');

    el.state = state({ phase: 'succeeded', previewUrl: 'blob:preview-1' });
    expect(el.hidden).toBe(true);
  });
});

describe('<civitai-run-logs>', () => {
  it('hides when empty, counts lines, and toggles its label', () => {
    const el = mount('civitai-run-logs');
    el.state = state({});
    expect(el.hidden).toBe(true);

    el.state = running({ logs: ['loading model', 'sampling'] });
    expect(el.hidden).toBe(false);
    expect(shadowText(el)).toContain('(2)');
    expect(el.shadowRoot!.querySelector('pre')!.textContent).toBe('loading model\nsampling');

    const details = el.shadowRoot!.querySelector<HTMLDetailsElement>('details.logs')!;
    const summary = details.querySelector('summary')!;
    expect(summary.textContent).toContain('Show logs');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    expect(summary.textContent).toContain('Hide logs');
  });
});

describe('<civitai-comfy-run>', () => {
  it('projects a pushed state into all children', () => {
    const el = mount('civitai-comfy-run');
    el.state = running({ logs: ['x'] });
    const status = el.shadowRoot!.querySelector('civitai-run-status')!;
    expect(status.state.phase).toBe('running');
    expect(el.shadowRoot!.querySelector('civitai-run-logs')!.state.logs).toEqual(['x']);
  });

  it('subscribes to a controller and unsubscribes on disconnect', () => {
    const listeners = new Set<(s: RunState) => void>();
    const fake = {
      getState: () => running(),
      subscribe: (fn: (s: RunState) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as RunController;

    const el = mount('civitai-comfy-run');
    el.controller = fake;
    expect(listeners.size).toBe(1);
    const next = running({ elapsedSeconds: 99 });
    for (const fn of listeners) fn(next);
    expect(el.shadowRoot!.querySelector('civitai-run-status')!.state.elapsedSeconds).toBe(99);

    el.remove();
    expect(listeners.size).toBe(0);
  });
});
