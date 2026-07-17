import { describe, expect, it } from 'vitest';

import { deriveRunPatch } from './derive.js';
import { INITIAL_RUN_STATE, type GatewayResult, type RunState } from './types.js';

const base = (over: Partial<RunState> = {}): RunState => ({ ...INITIAL_RUN_STATE, ...over });
const result = (over: Partial<GatewayResult['snapshot']>, detail?: GatewayResult['detail']) =>
  ({
    snapshot: { workflowId: 'wf_1', status: 'pending', ...over },
    ...(detail !== undefined && { detail }),
  }) as GatewayResult;

describe('deriveRunPatch — no detail (degraded bridge)', () => {
  it('maps pending → queued and processing → running', () => {
    expect(deriveRunPatch(base(), result({ status: 'pending' })).phase).toBe('queued');
    expect(deriveRunPatch(base(), result({ status: 'processing' })).phase).toBe('running');
  });
});

describe('deriveRunPatch — enriched ladder', () => {
  it('queued with position + eta', () => {
    const patch = deriveRunPatch(
      base(),
      result(
        { status: 'pending' },
        { orchStatus: 'scheduled', queue: { precedingJobs: 3, startAt: '2026-07-17T12:00:00Z' } },
      ),
    );
    expect(patch.phase).toBe('queued');
    expect(patch.queue).toEqual({ ahead: 3, etaStart: '2026-07-17T12:00:00Z' });
  });

  it('preparing carries the download fraction', () => {
    const patch = deriveRunPatch(
      base(),
      result(
        { status: 'processing' },
        { orchStatus: 'processing', job: { status: 'Preparing', progressRate: 0.42 } },
      ),
    );
    expect(patch.phase).toBe('preparing');
    expect(patch.prepProgress).toBe(0.42);
  });

  it('processing without TRACE compute evidence is starting; evidence flips to running', () => {
    const processing = (job?: { status?: string; progressRate?: number }) =>
      result({ status: 'processing' }, { orchStatus: 'processing', ...(job && { job }) });

    expect(deriveRunPatch(base(), processing()).phase).toBe('starting');
    // The orchestrator's derived progressRate is elapsed-time-based (nonzero
    // the moment a worker claims) — NOT compute evidence.
    expect(deriveRunPatch(base(), processing({ progressRate: 0.2 })).phase).toBe('starting');
    expect(
      deriveRunPatch(base({ sampler: { step: 3, total: 30, pct: 10 } }), processing()).phase,
    ).toBe('running');
    expect(deriveRunPatch(base({ phase: 'running' }), processing()).phase).toBe('running');
  });

  it('clears queue when processing starts', () => {
    const prev = base({ queue: { ahead: 2, etaStart: null } });
    const patch = deriveRunPatch(prev, result({ status: 'processing' }, { orchStatus: 'processing' }));
    expect(patch.queue).toBeNull();
  });
});

describe('deriveRunPatch — terminal', () => {
  it('succeeded settles cost from detail and grows imageUrls', () => {
    const patch = deriveRunPatch(
      base(),
      result(
        {
          status: 'succeeded',
          imageUrls: ['https://blob/1'],
          cost: { total: 41 },
          spentAccountType: 'yellow',
        },
        { cost: { total: 45 }, transactions: [{ accountType: 'yellow', amount: -45 }] },
      ),
    );
    expect(patch.phase).toBe('succeeded');
    expect(patch.imageUrls).toEqual(['https://blob/1']);
    expect(patch.settled).toEqual({
      total: 45,
      transactions: [{ accountType: 'yellow', amount: -45 }],
      spentAccountType: 'yellow',
    });
  });

  it('does not shrink imageUrls on a stale snapshot', () => {
    const prev = base({ imageUrls: ['a', 'b'] });
    const patch = deriveRunPatch(prev, result({ status: 'succeeded', imageUrls: ['a'] }));
    expect(patch.imageUrls).toBeUndefined();
  });

  it('failed keeps a trace-provided traceback and prefers the snapshot message', () => {
    const prev = base({ error: { message: 'old', traceback: 'Traceback: boom' } });
    const patch = deriveRunPatch(prev, result({ status: 'failed', error: 'node exploded' }));
    expect(patch.phase).toBe('failed');
    expect(patch.error).toEqual({ message: 'node exploded', traceback: 'Traceback: boom' });
  });

  it('expired maps to failed with a message', () => {
    const patch = deriveRunPatch(base(), result({ status: 'expired' }));
    expect(patch.phase).toBe('failed');
    expect(patch.error?.message).toMatch(/failed/i);
  });

  it('canceled settles from live usage when no cost landed', () => {
    const patch = deriveRunPatch(
      base(),
      result({ status: 'canceled' }, { usage: { estimatedCost: 14 } }),
    );
    expect(patch.phase).toBe('canceled');
    expect(patch.settled?.total).toBe(14);
    expect(patch.error).toBeUndefined();
  });
});
