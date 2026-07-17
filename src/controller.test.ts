import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_TRANSIENT_ERRORS,
  RETRY_MS,
  SCHEDULE_MS,
  type GatewayResult,
} from '@civitai/comfy-run-kit';

import { GenerationController, type WorkflowBridge } from './controller.js';

const pending = (id = 'wf_1'): GatewayResult => ({
  snapshot: { workflowId: id, status: 'pending' },
});
const processing = (urls?: string[]): GatewayResult => ({
  snapshot: { workflowId: 'wf_1', status: 'processing', ...(urls ? { imageUrls: urls } : {}) },
  detail: { orchStatus: 'processing', job: { progressRate: 0.3 } },
});
const succeeded = (): GatewayResult => ({
  snapshot: {
    workflowId: 'wf_1',
    status: 'succeeded',
    cost: { total: 47 },
    imageUrls: ['https://blob/1'],
    spentAccountType: 'yellow',
  },
});
const canceled = (): GatewayResult => ({
  snapshot: { workflowId: 'wf_1', status: 'canceled' },
  detail: { usage: { estimatedCost: 14 } },
});

type Bridge = WorkflowBridge & {
  submitted: unknown[];
  gateway: { submit: ReturnType<typeof vi.fn>; poll: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
};

function makeBridge(overrides: Partial<Bridge['gateway']> = {}, estimate?: Bridge['estimate']): Bridge {
  const submitted: unknown[] = [];
  return {
    submitted,
    estimate:
      estimate ??
      vi.fn(async () => ({ workflowId: 'wf_est', status: 'pending' as const, cost: { total: 60 } })),
    gateway: {
      submit: vi.fn(async (body: unknown) => {
        submitted.push(body);
        return pending();
      }),
      poll: vi.fn(async () => succeeded()),
      cancel: vi.fn(async () => canceled()),
      ...overrides,
    },
  };
}

/** Flush pending microtasks so awaited bridge promises settle under fake timers. */
const flush = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('GenerationController', () => {
  it('runs estimate -> submit -> poll to success and records cost + funder', async () => {
    const bridge = makeBridge();
    const controller = new GenerationController(bridge);
    const phases: string[] = [];
    controller.subscribe((s) => phases.push(s.phase));

    const gen = controller.generate({ prompt: 'a lake', mode: 'seamless' });
    await flush();
    await gen;
    expect(controller.getState().phase).toBe('polling');
    expect(controller.getState().estimatedCost).toBe(60);

    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.gateway.poll).toHaveBeenCalledWith('wf_1');
    const state = controller.getState();
    expect(state.phase).toBe('succeeded');
    expect(state.actualCost).toBe(47);
    expect(state.imageUrl).toBe('https://blob/1');
    expect(state.spentAccountType).toBe('yellow');
    expect(state.run?.phase).toBe('succeeded');
    expect(phases).toContain('estimating');
    expect(phases).toContain('submitting');
  });

  it('submits a pano360 body in seamless mode and textToImage in hosted mode', async () => {
    const bridge = makeBridge();
    const controller = new GenerationController(bridge);

    await controller.generate({ prompt: 'a lake', mode: 'seamless' });
    await controller.generate({ prompt: 'a lake', mode: 'hosted' });

    expect((bridge.submitted[0] as { kind: string }).kind).toBe('pano360');
    expect((bridge.submitted[1] as { kind: string }).kind).toBe('textToImage');
  });

  it('zimage mode submits the zimage-turbo engine; checkpoint threads through others', async () => {
    const bridge = makeBridge();
    const controller = new GenerationController(bridge);
    const checkpoint = { modelId: 112902, versionId: 126688 };

    await controller.generate({ prompt: 'a lake', mode: 'zimage', checkpoint });
    await controller.generate({ prompt: 'a lake', mode: 'seamless', checkpoint });
    await controller.generate({ prompt: 'a lake', mode: 'hosted', checkpoint });

    expect(bridge.submitted[0]).toMatchObject({ kind: 'pano360', engine: 'zimage-turbo' });
    expect(bridge.submitted[0]).not.toHaveProperty('checkpoint');
    expect(bridge.submitted[1]).toMatchObject({ kind: 'pano360', checkpoint });
    expect(bridge.submitted[2]).toMatchObject({
      kind: 'textToImage',
      modelId: 112902,
      modelVersionId: 126688,
    });
  });

  it('flux2 and qwen modes submit their DiT engines (checkpoint dropped)', async () => {
    const bridge = makeBridge();
    const controller = new GenerationController(bridge);
    const checkpoint = { modelId: 112902, versionId: 126688 };

    await controller.generate({ prompt: 'a lake', mode: 'flux2', checkpoint });
    await controller.generate({ prompt: 'a lake', mode: 'qwen', checkpoint });

    expect(bridge.submitted[0]).toMatchObject({ kind: 'pano360', engine: 'flux2-klein' });
    expect(bridge.submitted[0]).not.toHaveProperty('checkpoint');
    expect(bridge.submitted[1]).toMatchObject({ kind: 'pano360', engine: 'qwen-image' });
    expect(bridge.submitted[1]).not.toHaveProperty('checkpoint');
  });

  it('exposes the kit run state (progress detail) and streams urls on the schedule', async () => {
    let calls = 0;
    const bridge = makeBridge({
      poll: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return processing();
        if (calls === 2) return processing(['https://blob/preview']);
        return succeeded();
      }),
    });
    const controller = new GenerationController(bridge);
    await controller.generate({ prompt: 'a lake', mode: 'seamless' });

    await vi.advanceTimersByTimeAsync(1); // first tick (setTimeout 0)
    expect(calls).toBe(1);
    expect(controller.getState().run?.phase).toBe('starting');
    await vi.advanceTimersByTimeAsync(SCHEDULE_MS[0]); // 2000
    expect(calls).toBe(2);
    expect(controller.getState().imageUrl).toBe('https://blob/preview');
    expect(controller.getState().phase).toBe('polling');
    await vi.advanceTimersByTimeAsync(SCHEDULE_MS[1]); // 2000
    expect(calls).toBe(3);
    expect(controller.getState().phase).toBe('succeeded');
  });

  it('retries transient poll errors and gives up after the cap', async () => {
    const bridge = makeBridge({ poll: vi.fn(async () => Promise.reject(new Error('offline'))) });
    const controller = new GenerationController(bridge);
    await controller.generate({ prompt: 'a lake', mode: 'seamless' });

    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < MAX_TRANSIENT_ERRORS; i++) {
      await vi.advanceTimersByTimeAsync(RETRY_MS[RETRY_MS.length - 1]);
    }
    const state = controller.getState();
    expect(state.phase).toBe('failed');
    expect(state.error).toMatch(/several retries/);
    expect(bridge.gateway.poll).toHaveBeenCalledTimes(MAX_TRANSIENT_ERRORS + 1);
  });

  it('classifies a rejected submit (insufficient buzz)', async () => {
    const bridge = makeBridge({
      submit: vi.fn(async () => Promise.reject(new Error('Insufficient Buzz for this generation'))),
    });
    const controller = new GenerationController(bridge);
    await controller.generate({ prompt: 'a lake', mode: 'seamless' });
    expect(controller.getState().phase).toBe('insufficient');
  });

  it('a terminal failed submit result short-circuits without polling', async () => {
    const bridge = makeBridge({
      submit: vi.fn(async () => ({
        snapshot: { workflowId: 'wf_1', status: 'failed' as const, error: 'node type not found' },
      })),
    });
    const controller = new GenerationController(bridge);
    await controller.generate({ prompt: 'a lake', mode: 'seamless' });
    expect(controller.getState().phase).toBe('failed');
    expect(controller.getState().error).toBe('node type not found');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bridge.gateway.poll).not.toHaveBeenCalled();
  });

  it('cancel() delegates to the run — terminal canceled with reason "user"', async () => {
    const bridge = makeBridge({ poll: vi.fn(async () => processing()) });
    const controller = new GenerationController(bridge);
    await controller.generate({ prompt: 'a lake', mode: 'seamless' });
    await vi.advanceTimersByTimeAsync(1);

    controller.cancel();
    await flush();
    expect(bridge.gateway.cancel).toHaveBeenCalledWith('wf_1');
    const state = controller.getState();
    expect(state.phase).toBe('canceled');
    expect(state.run?.canceledReason).toBe('user');
    expect(state.actualCost).toBe(14); // elapsed-only bill from live usage
  });

  it('an estimate failure with insufficient wording stops before submit', async () => {
    const bridge = makeBridge(
      {},
      vi.fn(async () => ({
        workflowId: 'wf_est',
        status: 'failed' as const,
        error: 'not enough buzz',
      })),
    );
    const controller = new GenerationController(bridge);
    await controller.generate({ prompt: 'a lake', mode: 'seamless' });
    expect(controller.getState().phase).toBe('insufficient');
    expect(bridge.gateway.submit).not.toHaveBeenCalled();
  });

  it('a thrown estimate is non-fatal (estimate becomes unknown, submit proceeds)', async () => {
    const bridge = makeBridge({}, vi.fn(async () => Promise.reject(new Error('timeout'))));
    const controller = new GenerationController(bridge);
    await controller.generate({ prompt: 'a lake', mode: 'seamless' });
    expect(bridge.gateway.submit).toHaveBeenCalled();
    expect(controller.getState().estimatedCost).toBeNull();
  });

  it('stopPolling abandons the run; a resolved poll after that applies nothing', async () => {
    let resolveFirstPoll: ((r: GatewayResult) => void) | null = null;
    const bridge = makeBridge({
      poll: vi.fn(() => new Promise<GatewayResult>((resolve) => (resolveFirstPoll = resolve))),
    });
    const controller = new GenerationController(bridge);
    await controller.generate({ prompt: 'a lake', mode: 'seamless' });
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.gateway.poll).toHaveBeenCalledTimes(1);

    controller.stopPolling();
    resolveFirstPoll!(succeeded());
    await flush();
    expect(controller.getState().phase).toBe('polling'); // disposed run applied nothing
  });
});
