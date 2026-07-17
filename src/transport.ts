// Framework-free bridge to the Civitai Apps host. The SDK's transport classes
// carry no React — only its hooks do — so this module wraps the singleton
// transport ({@link getTransport}) with the calls the app needs: estimate,
// sign-in/consent, balance, resize, plus a comfy-run-kit BridgeGateway over the
// same transport for the workflow lifecycle (submit/poll/cancel).

import { getTransport, sendTypedRequest } from '@civitai/blocks-react';
import type { BlockSnapshot, BlockTransport } from '@civitai/blocks-react';
import type {
  BlockCheckpointInfo,
  BlockWorkflowSnapshot,
  WorkflowBody,
} from '@civitai/app-sdk/blocks';
import { BridgeGateway } from '@civitai/comfy-run-kit/bridge';

import { BUDGETED_SCOPE } from './generation.js';
import type { WorkflowBridge } from './controller.js';

export interface BuzzBalance {
  blue: number;
  green: number;
  yellow: number;
}

export interface BlockSession extends WorkflowBridge {
  /** Live host snapshot (ready flag, viewer, theme, token scopes). */
  getSnapshot(): BlockSnapshot;
  /** Subscribe to snapshot changes (BLOCK_INIT, TOKEN_REFRESH, theme). */
  subscribe(listener: () => void): () => void;
  /** Does the current token carry the budgeted-spend scope? */
  canGenerate(): boolean;
  requestSignIn(): void;
  requestConsent(): void;
  /** Read the viewer's Buzz wallet; null when the host can't answer. */
  getBuzzBalance(): Promise<BuzzBalance | null>;
  /**
   * Open the host's checkpoint picker filtered to a base-model family.
   * Resolves the pick (discovery-only — the server re-validates at submit)
   * or null when the user dismissed / the host can't show a picker.
   */
  openCheckpointPicker(options: {
    baseModelGroup: string;
    currentVersionId?: number;
  }): Promise<BlockCheckpointInfo | null>;
  /** Report the block's rendered height so the host can size the iframe. */
  resize(height: number): void;
}

/**
 * Create the session over the process-wide transport. In production the
 * transport reads its parent-origin allowlist from
 * VITE_BLOCK_ALLOWED_PARENT_ORIGINS; the dev harness pre-initializes it with
 * the local origin before calling this (see dev-transport.ts). Never blocks:
 * outbound requests queue until BLOCK_INIT lands, and the UI gates on
 * `getSnapshot().ready`.
 */
export function createBlockSession(transport: BlockTransport = getTransport()): BlockSession {
  return {
    gateway: new BridgeGateway(transport),

    getSnapshot: () => transport.getSnapshot(),
    subscribe: (listener) => transport.subscribe(listener),

    canGenerate: () => {
      const scopes = transport.getSnapshot().token.scopes;
      return Array.isArray(scopes) && scopes.includes(BUDGETED_SCOPE);
    },

    async estimate(body: WorkflowBody): Promise<BlockWorkflowSnapshot> {
      const payload = await sendTypedRequest(
        transport,
        { type: 'ESTIMATE_WORKFLOW', payload: { body } },
        'ESTIMATE_RESULT',
      );
      return payload.snapshot;
    },

    requestSignIn: () => transport.sendMessage({ type: 'REQUEST_SIGN_IN' }),

    requestConsent: () =>
      transport.sendMessage({ type: 'REQUEST_CONSENT', payload: { scopes: [BUDGETED_SCOPE] } }),

    async getBuzzBalance(): Promise<BuzzBalance | null> {
      try {
        const payload = await sendTypedRequest(
          transport,
          { type: 'GET_BUZZ_BALANCE', payload: {} },
          'BUZZ_BALANCE_RESULT',
        );
        return payload.balance ?? null;
      } catch {
        return null;
      }
    },

    async openCheckpointPicker(options): Promise<BlockCheckpointInfo | null> {
      try {
        const payload = await sendTypedRequest(
          transport,
          { type: 'OPEN_CHECKPOINT_PICKER', payload: { ...options } },
          'CHECKPOINT_PICKER_RESULT',
        );
        return payload.selected ?? null;
      } catch {
        return null;
      }
    },

    resize: (height) => transport.sendMessage({ type: 'RESIZE_IFRAME', payload: { height } }),
  };
}
