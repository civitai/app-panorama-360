import { describe, expect, it, vi } from 'vitest';

import { DirectGateway } from './direct-gateway.js';

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'wf_1',
  status: 'processing',
  steps: [
    {
      name: 'pano',
      jobs: [{ status: 'Preparing', estimatedProgressRate: 0.5 }],
      output: { usage: { buzzPerSecond: 1, estimatedCost: 3 }, traceUrl: 'https://orch/trace/1' },
    },
  ],
  ...over,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const noRetryWait = { retry: { sleep: async () => undefined, jitter: () => 0 } };

describe('DirectGateway', () => {
  it('submit POSTs the body with wait=0 and maps snapshot + detail', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(doc()));
    const gw = new DirectGateway({
      baseUrl: '/orch',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      stepName: 'pano',
      rewriteTraceUrl: (u) => u.replace('https://orch', '/orch'),
      ...noRetryWait,
    });
    const result = await gw.submit({ steps: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/orch/v2/consumer/workflows?wait=0',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ steps: [] }) }),
    );
    expect(result.snapshot).toMatchObject({ workflowId: 'wf_1', status: 'processing' });
    expect(result.detail).toMatchObject({
      orchStatus: 'processing',
      job: { status: 'Preparing', progressRate: 0.5 },
      usage: { buzzPerSecond: 1, estimatedCost: 3 },
      traceUrl: '/orch/trace/1',
    });
  });

  it('poll long-polls with wait, latching to plain GET on a 400', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('wait must be boolean', { status: 400 }))
      .mockImplementation(() => Promise.resolve(jsonResponse(doc())));
    const gw = new DirectGateway({
      baseUrl: '/orch',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...noRetryWait,
    });
    await gw.poll('wf_1');
    await gw.poll('wf_1');
    const urls = fetchImpl.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toBe('/orch/v2/consumer/workflows/wf_1?wait=10');
    expect(urls[1]).toBe('/orch/v2/consumer/workflows/wf_1');
    // Latched: the second poll() never tries wait again.
    expect(urls[2]).toBe('/orch/v2/consumer/workflows/wf_1');
  });

  it('cancel PUTs status canceled and maps the returned doc', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(doc({ status: 'canceled' })));
    const gw = new DirectGateway({
      baseUrl: '/orch',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...noRetryWait,
    });
    const result = await gw.cancel('wf_1');
    expect(fetchImpl).toHaveBeenCalledWith(
      '/orch/v2/consumer/workflows/wf_1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 'canceled' }) }),
    );
    expect(result.snapshot.status).toBe('canceled');
  });

  it('cancel falls back to a GET when the PUT returns no document', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(doc({ status: 'canceled' })));
    const gw = new DirectGateway({
      baseUrl: '/orch',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...noRetryWait,
    });
    const result = await gw.cancel('wf_1');
    expect(result.snapshot.status).toBe('canceled');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/orch/v2/consumer/workflows/wf_1');
  });

  it('retries transient statuses, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(doc()));
    const gw = new DirectGateway({
      baseUrl: '/orch',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      waitSeconds: 0,
      ...noRetryWait,
    });
    const result = await gw.poll('wf_1');
    expect(result.snapshot.workflowId).toBe('wf_1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces non-retryable errors with status and body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('insufficient buzz', { status: 402 }));
    const gw = new DirectGateway({
      baseUrl: '/orch',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...noRetryWait,
    });
    await expect(gw.submit({})).rejects.toThrow(/402: insufficient buzz/);
  });
});
