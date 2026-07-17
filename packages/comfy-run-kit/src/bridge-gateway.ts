// RunGateway over the block postMessage bridge (`./bridge` subpath — the only
// kit module that imports the block SDK). SUBMIT/POLL/CANCEL_WORKFLOW all exist
// in the published protocol and in the real civitai.com hosts; the optional
// `detail` enrichment rides beside the snapshot on hosts that attach it (extra
// payload fields survive the postMessage clone) and its absence just degrades
// the run to elapsed-time + an indeterminate bar.

import { getTransport, sendTypedRequest } from '@civitai/blocks-react';
import type { BlockTransport } from '@civitai/blocks-react';
import type { BlockWorkflowSnapshot, WorkflowBody } from '@civitai/app-sdk/blocks';

import type { GatewayResult, RunDetail, RunGateway, RunSnapshot } from './types.js';

function toResult(payload: { snapshot: BlockWorkflowSnapshot }): GatewayResult {
  const detail = (payload as { detail?: RunDetail }).detail;
  return {
    snapshot: payload.snapshot as RunSnapshot,
    ...(detail !== undefined && { detail }),
  };
}

export class BridgeGateway implements RunGateway {
  constructor(private readonly transport: BlockTransport = getTransport()) {}

  async submit(body: unknown): Promise<GatewayResult> {
    const payload = await sendTypedRequest(
      this.transport,
      { type: 'SUBMIT_WORKFLOW', payload: { body: body as WorkflowBody } },
      'WORKFLOW_SUBMITTED',
    );
    return toResult(payload);
  }

  async poll(workflowId: string): Promise<GatewayResult> {
    const payload = await sendTypedRequest(
      this.transport,
      { type: 'POLL_WORKFLOW', payload: { workflowId } },
      'WORKFLOW_STATUS',
    );
    return toResult(payload);
  }

  async cancel(workflowId: string): Promise<GatewayResult> {
    const payload = await sendTypedRequest(
      this.transport,
      { type: 'CANCEL_WORKFLOW', payload: { workflowId } },
      'WORKFLOW_CANCELED',
    );
    return toResult(payload);
  }
}
