import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@civitai/blocks-react', () => ({
  getTransport: vi.fn(() => ({ mocked: true })),
  sendTypedRequest: vi.fn(),
}));

import { sendTypedRequest } from '@civitai/blocks-react';

import { BridgeGateway } from './bridge-gateway.js';
import type { RunDetail } from './types.js';

const sendMock = vi.mocked(sendTypedRequest);
const transport = { fake: true } as never;

describe('BridgeGateway', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('submit sends SUBMIT_WORKFLOW and reads snapshot + detail off the reply', async () => {
    const detail: RunDetail = { orchStatus: 'processing', usage: { estimatedCost: 4 } };
    sendMock.mockResolvedValue({
      requestId: 'r1',
      snapshot: { workflowId: 'wf_1', status: 'processing' },
      detail,
    } as never);
    const gw = new BridgeGateway(transport);
    const result = await gw.submit({ kind: 'pano360', prompt: 'a lake' });
    expect(sendMock).toHaveBeenCalledWith(
      transport,
      { type: 'SUBMIT_WORKFLOW', payload: { body: { kind: 'pano360', prompt: 'a lake' } } },
      'WORKFLOW_SUBMITTED',
    );
    expect(result.snapshot.workflowId).toBe('wf_1');
    expect(result.detail).toEqual(detail);
  });

  it('poll degrades gracefully when the host attaches no detail', async () => {
    sendMock.mockResolvedValue({
      requestId: 'r2',
      snapshot: { workflowId: 'wf_1', status: 'pending' },
    } as never);
    const gw = new BridgeGateway(transport);
    const result = await gw.poll('wf_1');
    expect(sendMock).toHaveBeenCalledWith(
      transport,
      { type: 'POLL_WORKFLOW', payload: { workflowId: 'wf_1' } },
      'WORKFLOW_STATUS',
    );
    expect(result.detail).toBeUndefined();
  });

  it('cancel uses the CANCEL_WORKFLOW / WORKFLOW_CANCELED pair', async () => {
    sendMock.mockResolvedValue({
      requestId: 'r3',
      snapshot: { workflowId: 'wf_1', status: 'canceled' },
    } as never);
    const gw = new BridgeGateway(transport);
    const result = await gw.cancel('wf_1');
    expect(sendMock).toHaveBeenCalledWith(
      transport,
      { type: 'CANCEL_WORKFLOW', payload: { workflowId: 'wf_1' } },
      'WORKFLOW_CANCELED',
    );
    expect(result.snapshot.status).toBe('canceled');
  });
});
