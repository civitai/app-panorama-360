import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';
import type { BlockSnapshot } from '@civitai/blocks-react';
import type { GatewayResult } from '@civitai/comfy-run-kit';

// PSV needs WebGL; replace it with a recording stub before the components load.
const viewerInstances: FakeViewer[] = [];
class FakeViewer {
  panorama: string;
  destroyed = false;
  #listeners = new Map<string, Array<() => void>>();
  constructor(opts: { panorama: string }) {
    this.panorama = opts.panorama;
    viewerInstances.push(this);
    queueMicrotask(() => this.#emit('ready'));
  }
  addEventListener(type: string, fn: () => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }
  async setPanorama(url: string): Promise<void> {
    this.panorama = url;
  }
  destroy(): void {
    this.destroyed = true;
  }
  #emit(type: string): void {
    for (const fn of this.#listeners.get(type) ?? []) fn();
  }
}
vi.mock('@photo-sphere-viewer/core', () => ({ Viewer: FakeViewer }));

import { registerElements } from './registry.js';
import type { PanoApp } from './components/pano-app.js';
import type { PanoControls } from './components/pano-controls.js';
import type { BlockSession, BuzzBalance } from './transport.js';

registerElements();

interface FakeSessionOptions {
  viewer?: { id: number; username: string } | null;
  scopes?: string[];
  balance?: BuzzBalance | null;
  submitResult?: GatewayResult;
  pollResult?: GatewayResult;
}

function makeSession(options: FakeSessionOptions = {}) {
  const listeners = new Set<() => void>();
  let snapshot = {
    ready: true,
    theme: 'dark',
    viewer: options.viewer === undefined ? { id: 1, username: 'dev' } : options.viewer,
    token: { scopes: options.scopes ?? ['ai:write:budgeted'] },
  } as unknown as BlockSnapshot;

  const submitted: unknown[] = [];
  const gateway = {
    submit: vi.fn(async (body: unknown): Promise<GatewayResult> => {
      submitted.push(body);
      return (
        options.submitResult ?? {
          snapshot: {
            workflowId: 'wf_1',
            status: 'succeeded',
            cost: { total: 42 },
            imageUrls: ['https://blob/pano.png'],
          },
        }
      );
    }),
    poll: vi.fn(
      async (): Promise<GatewayResult> =>
        options.pollResult ?? { snapshot: { workflowId: 'wf_1', status: 'succeeded' } },
    ),
    cancel: vi.fn(
      async (): Promise<GatewayResult> => ({
        snapshot: { workflowId: 'wf_1', status: 'canceled' },
      }),
    ),
  };
  const session = {
    gateway,
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    canGenerate: () => (snapshot.token.scopes ?? []).includes('ai:write:budgeted'),
    estimate: vi.fn(async (): Promise<BlockWorkflowSnapshot> => ({
      workflowId: 'wf_est',
      status: 'pending',
      cost: { total: 60 },
    })),
    requestSignIn: vi.fn(),
    requestConsent: vi.fn(),
    getBuzzBalance: vi.fn(async () => options.balance ?? { blue: 100, green: 0, yellow: 900 }),
    resize: vi.fn(),
  } satisfies BlockSession & Record<string, unknown>;

  return {
    session,
    submitted,
    patchSnapshot(patch: Record<string, unknown>) {
      snapshot = { ...snapshot, ...patch } as BlockSnapshot;
      for (const fn of listeners) fn();
    },
  };
}

function mountApp(session: BlockSession): PanoApp {
  const app = document.createElement('pano-app') as PanoApp;
  app.session = session;
  app.seamlessAvailable = true;
  document.body.appendChild(app);
  return app;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = '';
  viewerInstances.length = 0;
});

describe('<pano-controls>', () => {
  it('preset click fills the prompt; generate emits a PanoRequest', () => {
    const controls = document.createElement('pano-controls') as PanoControls;
    document.body.appendChild(controls);
    controls.seamlessAvailable = true;

    const events: CustomEvent[] = [];
    controls.addEventListener('pano-generate', ((e: CustomEvent) =>
      events.push(e)) as unknown as EventListener);

    (controls.querySelector('[data-testid=pn-preset-alpine]') as HTMLButtonElement).click();
    (controls.querySelector('[data-testid=pn-seed]') as HTMLInputElement).value = '42';
    (controls.querySelector('[data-testid=pn-generate]') as HTMLButtonElement).click();

    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ mode: 'seamless', seed: 42 });
    expect(events[0].detail.prompt).toContain('icy lake');
  });

  it('empty prompt does not emit; seamless chip disabled when unavailable', () => {
    const controls = document.createElement('pano-controls') as PanoControls;
    document.body.appendChild(controls);
    controls.seamlessAvailable = false;

    const events: Event[] = [];
    controls.addEventListener('pano-generate', (e) => events.push(e));
    (controls.querySelector('[data-testid=pn-generate]') as HTMLButtonElement).click();
    expect(events).toHaveLength(0);

    const seamlessBtn = controls.querySelector('[data-testid=pn-mode-seamless]') as HTMLButtonElement;
    expect(seamlessBtn.disabled).toBe(true);
    expect(controls.mode).toBe('hosted');
  });
});

describe('<pano-app>', () => {
  it('runs a generation end-to-end and shows the panorama in the viewer', async () => {
    const { session, submitted } = makeSession();
    const app = mountApp(session);
    await flush();

    (app.querySelector('[data-testid=pn-preset-beach]') as HTMLButtonElement).click();
    (app.querySelector('[data-testid=pn-generate]') as HTMLButtonElement).click();
    await flush();
    await flush();

    expect(session.estimate).toHaveBeenCalled();
    expect(submitted).toHaveLength(1);
    expect((submitted[0] as { kind: string }).kind).toBe('pano360');

    expect(viewerInstances).toHaveLength(1);
    expect(viewerInstances[0].panorama).toBe('https://blob/pano.png');
    expect(app.querySelector('[data-testid=pn-alert-success]')?.textContent).toContain('42');
  });

  it('anonymous viewer: generate routes to sign-in', async () => {
    const { session } = makeSession({ viewer: null });
    const app = mountApp(session);
    await flush();

    (app.querySelector('[data-testid=pn-generate]') as HTMLButtonElement).click();
    expect(session.requestSignIn).toHaveBeenCalled();
    expect(session.gateway.submit).not.toHaveBeenCalled();
  });

  it('missing budgeted scope: asks consent, then auto-runs after the grant', async () => {
    const { session, patchSnapshot, submitted } = makeSession({ scopes: [] });
    const app = mountApp(session);
    await flush();

    (app.querySelector('[data-testid=pn-preset-alpine]') as HTMLButtonElement).click();
    (app.querySelector('[data-testid=pn-generate]') as HTMLButtonElement).click();
    expect(session.requestConsent).toHaveBeenCalled();
    expect(session.gateway.submit).not.toHaveBeenCalled();
    expect(app.querySelector('[data-testid=pn-alert-info]')?.textContent).toMatch(/Confirm/);

    patchSnapshot({ token: { scopes: ['ai:write:budgeted'] } });
    await flush();
    await flush();
    expect(submitted).toHaveLength(1);
  });

  it('renders the Buzz balance strip once ready', async () => {
    const { session } = makeSession({ balance: { blue: 10, green: 20, yellow: 30 } });
    const app = mountApp(session);
    await flush();
    expect(app.querySelector('.pn-balance')?.textContent).toContain('Total 60 Buzz');
  });

  it('the run card cancel button interrupts the run server-side', async () => {
    const processing: GatewayResult = {
      snapshot: { workflowId: 'wf_1', status: 'processing' },
      detail: { orchStatus: 'processing', usage: { buzzPerSecond: 1, estimatedCost: 3 } },
    };
    const { session } = makeSession({ submitResult: processing, pollResult: processing });
    const app = mountApp(session);
    await flush();

    (app.querySelector('[data-testid=pn-preset-alpine]') as HTMLButtonElement).click();
    (app.querySelector('[data-testid=pn-generate]') as HTMLButtonElement).click();
    await flush();
    await flush();

    const comfyRun = app.querySelector<HTMLElement>('pano-status civitai-comfy-run')!;
    expect(comfyRun.hidden).toBe(false);
    const runStatus = comfyRun.shadowRoot!.querySelector('civitai-run-status')!;
    const button = runStatus.shadowRoot!.querySelector<HTMLButtonElement>('button.cancel')!;
    expect(button.hidden).toBe(false);

    button.click();
    await flush();
    expect(session.gateway.cancel).toHaveBeenCalledWith('wf_1');
    expect(runStatus.shadowRoot!.textContent).toContain('Canceled');
  });
});
