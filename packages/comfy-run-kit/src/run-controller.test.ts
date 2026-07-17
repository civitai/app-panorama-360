import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunController, type TraceTailerControl } from './run-controller.js';
import type { TraceTailerHandlers } from './trace/tailer.js';
import type { GatewayResult, RunGateway } from './types.js';

const T0 = Date.parse('2026-07-17T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const pending = (workflowId = 'wf_1'): GatewayResult => ({
  snapshot: { workflowId, status: 'pending' },
  detail: { orchStatus: 'scheduled', queue: { precedingJobs: 2 } },
});

const processing = (extra: Partial<NonNullable<GatewayResult['detail']>> = {}): GatewayResult => ({
  snapshot: { workflowId: 'wf_1', status: 'processing' },
  detail: { orchStatus: 'processing', ...extra },
});

const usageDetail = () => ({
  usage: {
    buzzPerSecond: 1,
    estimatedCost: 5,
    runtimeSeconds: 5,
    startedAt: iso(Date.now() - 5_000),
    computedAt: iso(Date.now()),
  },
});

const succeeded = (): GatewayResult => ({
  snapshot: { workflowId: 'wf_1', status: 'succeeded', imageUrls: ['https://blob/1'] },
  detail: { cost: { total: 45 }, transactions: [{ accountType: 'yellow', amount: -45 }] },
});

const canceled = (detail: GatewayResult['detail'] = {}): GatewayResult => ({
  snapshot: { workflowId: 'wf_1', status: 'canceled' },
  detail,
});

function fakeGateway(): { [K in keyof RunGateway]: ReturnType<typeof vi.fn> } & RunGateway {
  return {
    submit: vi.fn(),
    poll: vi.fn(),
    cancel: vi.fn(),
  } as never;
}

describe('RunController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drives submit → poll → succeeded, settling the buzz meter', async () => {
    const gw = fakeGateway();
    gw.submit.mockResolvedValue(pending());
    gw.poll
      .mockResolvedValueOnce(processing(usageDetail()))
      .mockResolvedValueOnce(succeeded());
    const rc = new RunController({ gateway: gw, createTraceTailer: null });
    const phases: string[] = [];
    rc.subscribe((s) => {
      if (phases[phases.length - 1] !== s.phase) phases.push(s.phase);
    });

    await rc.start({ kind: 'pano360' });
    expect(rc.getState().phase).toBe('queued');
    expect(rc.getState().queue).toEqual({ ahead: 2, etaStart: null });

    await vi.advanceTimersByTimeAsync(1); // first poll
    expect(rc.getState().phase).toBe('starting');
    expect(rc.getState().buzz.rate).toBe(1);

    await vi.advanceTimersByTimeAsync(2_001); // second poll → terminal
    expect(rc.getState().phase).toBe('succeeded');
    expect(rc.getState().imageUrls).toEqual(['https://blob/1']);
    expect(rc.getState().settled).toEqual({
      total: 45,
      transactions: [{ accountType: 'yellow', amount: -45 }],
      spentAccountType: null,
    });
    expect(rc.getState().buzz).toEqual({ live: 45, rate: 1, settled: true });
    expect(phases).toEqual(['submitting', 'queued', 'starting', 'succeeded']);

    // Terminal: the ticker is stopped and no further polls fire.
    const polls = gw.poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gw.poll.mock.calls.length).toBe(polls);
  });

  it('ticks elapsedSeconds and the live buzz while busy', async () => {
    const gw = fakeGateway();
    gw.submit.mockResolvedValue(pending());
    gw.poll.mockResolvedValue(processing(usageDetail()));
    const rc = new RunController({ gateway: gw, createTraceTailer: null });
    await rc.start({});
    await vi.advanceTimersByTimeAsync(3_000);
    expect(rc.getState().elapsedSeconds).toBe(3);
    expect(rc.getState().buzz.live).toBeGreaterThanOrEqual(5);
  });

  it('rides out transient poll errors on the retry ladder', async () => {
    const gw = fakeGateway();
    gw.submit.mockResolvedValue(pending());
    gw.poll
      .mockRejectedValueOnce(new Error('blip'))
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce(succeeded());
    const rc = new RunController({ gateway: gw, createTraceTailer: null });
    await rc.start({});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rc.getState().phase).toBe('succeeded');
  });

  it('gives up after MAX_TRANSIENT_ERRORS consecutive poll failures', async () => {
    const gw = fakeGateway();
    gw.submit.mockResolvedValue(pending());
    gw.poll.mockRejectedValue(new Error('down'));
    const rc = new RunController({ gateway: gw, createTraceTailer: null });
    await rc.start({});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rc.getState().phase).toBe('failed');
    expect(rc.getState().error?.message).toMatch(/several retries/);
  });

  it('a submit failure fails the run with the error message', async () => {
    const gw = fakeGateway();
    gw.submit.mockRejectedValue(new Error('Orchestrator 401: unauthorized'));
    const rc = new RunController({ gateway: gw, createTraceTailer: null });
    await rc.start({});
    expect(rc.getState().phase).toBe('failed');
    expect(rc.getState().error?.message).toMatch(/401/);
  });

  it('cancel() flags the user cancel before the wire call → reason "user"', async () => {
    const gw = fakeGateway();
    gw.submit.mockResolvedValue(pending());
    gw.poll.mockResolvedValue(processing(usageDetail()));
    gw.cancel.mockResolvedValue(canceled({ usage: { estimatedCost: 12 } }));
    const rc = new RunController({ gateway: gw, createTraceTailer: null });
    await rc.start({});
    await vi.advanceTimersByTimeAsync(1);

    await rc.cancel();
    expect(gw.cancel).toHaveBeenCalledWith('wf_1');
    expect(rc.getState().phase).toBe('canceled');
    expect(rc.getState().canceledReason).toBe('user');
    expect(rc.getState().cancelPending).toBe(false);
    expect(rc.getState().settled?.total).toBe(12);
  });

  it('a failed cancel re-enables the button and polling converges', async () => {
    const gw = fakeGateway();
    gw.submit.mockResolvedValue(pending());
    gw.poll.mockResolvedValue(processing());
    gw.cancel.mockRejectedValue(new Error('409'));
    const rc = new RunController({ gateway: gw, createTraceTailer: null });
    await rc.start({});
    await rc.cancel();
    expect(rc.getState().cancelPending).toBe(false);
    expect(rc.getState().phase).not.toBe('canceled');
  });

  it('a non-terminal cancel reply also re-enables the button', async () => {
    const gw = fakeGateway();
    gw.submit.mockResolvedValue(pending());
    gw.poll.mockResolvedValue(processing());
    gw.cancel.mockResolvedValue(processing());
    const rc = new RunController({ gateway: gw, createTraceTailer: null });
    await rc.start({});
    await rc.cancel();
    expect(rc.getState().cancelPending).toBe(false);
    expect(rc.getState().phase).not.toBe('canceled');
  });

  it('an uninitiated terminal cancel is outOfBuzz when billing was running', async () => {
    const gw = fakeGateway();
    gw.submit.mockResolvedValue(pending());
    gw.poll
      .mockResolvedValueOnce(processing(usageDetail()))
      .mockResolvedValueOnce(canceled({ usage: { estimatedCost: 30 } }));
    const rc = new RunController({ gateway: gw, createTraceTailer: null });
    await rc.start({});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rc.getState().phase).toBe('canceled');
    expect(rc.getState().canceledReason).toBe('outOfBuzz');
  });

  it('an uninitiated cancel with no usage ever observed is "unknown"', async () => {
    const gw = fakeGateway();
    gw.submit.mockResolvedValue(pending());
    gw.poll.mockResolvedValueOnce(canceled());
    const rc = new RunController({ gateway: gw, createTraceTailer: null });
    await rc.start({});
    await vi.advanceTimersByTimeAsync(1);
    expect(rc.getState().canceledReason).toBe('unknown');
  });

  it('an instant cancel with a zero-accrual usage block is "unknown", not outOfBuzz', async () => {
    const gw = fakeGateway();
    gw.submit.mockResolvedValue(pending());
    // The orchestrator reports usage {rate: 1, runtime: 0, cost: 0} even for a
    // run it killed before it started (e.g. unresolvable nodepack layer).
    gw.poll.mockResolvedValueOnce(
      canceled({ usage: { buzzPerSecond: 1, runtimeSeconds: 0, estimatedCost: 0 } }),
    );
    const rc = new RunController({ gateway: gw, createTraceTailer: null });
    await rc.start({});
    await vi.advanceTimersByTimeAsync(1);
    expect(rc.getState().canceledReason).toBe('unknown');
  });

  it('wires the trace tailer once and folds its events into state', async () => {
    const gw = fakeGateway();
    gw.submit.mockResolvedValue(pending());
    gw.poll
      .mockResolvedValueOnce(processing({ traceUrl: '/orch/trace/1' }))
      .mockResolvedValueOnce(processing({ traceUrl: '/orch/trace/1' }))
      .mockResolvedValueOnce(succeeded());
    const control: TraceTailerControl = {
      start: vi.fn(),
      notifyTerminal: vi.fn(),
      stop: vi.fn(),
    };
    let handlers: TraceTailerHandlers | undefined;
    const factory = vi.fn((_url: string, h: TraceTailerHandlers) => {
      handlers = h;
      return control;
    });
    const revoke = vi.fn();
    let urlCounter = 0;
    const rc = new RunController({
      gateway: gw,
      createTraceTailer: factory,
      nodeLabels: { '7': 'KSampler' },
      createObjectUrl: () => `blob:${++urlCounter}`,
      revokeObjectUrl: revoke,
    });
    await rc.start({});
    await vi.advanceTimersByTimeAsync(1);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('/orch/trace/1', expect.anything());
    expect(control.start).toHaveBeenCalledTimes(1);

    handlers?.onEvent?.({ type: 'executing', data: { node: '7' } });
    expect(rc.getState().currentNode).toBe('KSampler');
    expect(rc.getState().phase).toBe('running');

    handlers?.onEvent?.({ type: 'progress', data: { value: 12, max: 30 } });
    expect(rc.getState().sampler).toEqual({ step: 12, total: 30, pct: 40 });

    handlers?.onEvent?.({
      type: 'logs',
      data: { entries: [{ t: 'x', m: '\u001b[32m[INFO]\u001b[0m loading model' }] },
    });
    expect(rc.getState().logs).toEqual(['[INFO] loading model']);

    handlers?.onEvent?.({
      type: 'execution_error',
      data: { exception_message: 'boom', traceback: ['Traceback:\n', '  boom\n'] },
    });
    expect(rc.getState().error).toEqual({ message: 'boom', traceback: 'Traceback:\n  boom\n' });

    handlers?.onPreview?.(new Blob(['x']));
    expect(rc.getState().previewUrl).toBe('blob:1');
    handlers?.onPreview?.(new Blob(['y']));
    expect(rc.getState().previewUrl).toBe('blob:2');
    expect(revoke).toHaveBeenCalledWith('blob:1');

    await vi.advanceTimersByTimeAsync(10_000); // polls 2 + 3 → terminal
    expect(factory).toHaveBeenCalledTimes(1);
    expect(control.notifyTerminal).toHaveBeenCalled();
  });

  it('dispose() stops the ticker, poll loop, and tailer', async () => {
    const gw = fakeGateway();
    gw.submit.mockResolvedValue(pending());
    gw.poll.mockResolvedValue(processing({ traceUrl: '/t' }));
    const control: TraceTailerControl = { start: vi.fn(), notifyTerminal: vi.fn(), stop: vi.fn() };
    const rc = new RunController({
      gateway: gw,
      createTraceTailer: () => control,
    });
    const listener = vi.fn();
    rc.subscribe(listener);
    await rc.start({});
    await vi.advanceTimersByTimeAsync(1);

    rc.dispose();
    const calls = listener.mock.calls.length;
    const polls = gw.poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listener.mock.calls.length).toBe(calls);
    expect(gw.poll.mock.calls.length).toBe(polls);
    expect(control.stop).toHaveBeenCalled();
  });
});
