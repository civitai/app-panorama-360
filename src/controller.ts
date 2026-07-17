// App-level generation state machine; the submit → poll → terminal lifecycle
// is delegated to a per-run comfy-run-kit RunController, exposed as
// `ControllerState.run` for the kit elements to render.

import type { BlockWorkflowSnapshot, BuzzAccountType, WorkflowBody } from '@civitai/app-sdk/blocks';
import { RunController, type RunGateway, type RunState } from '@civitai/comfy-run-kit';

import { phaseForError, type GenPhase } from './generation.js';
import {
  FLUX2_ESTIMATE_BUZZ,
  FLUX2_NODE_LABELS,
  PANORAMA_ESTIMATE_BUZZ,
  PANO_NODE_LABELS,
  QWEN_ESTIMATE_BUZZ,
  QWEN_NODE_LABELS,
  STANDARD_NODE_LABELS,
  ZIMAGE_ESTIMATE_BUZZ,
  ZIMAGE_NODE_LABELS,
  buildHostedBody,
  buildPanoBody,
  type PanoCheckpoint,
  type PanoEngine,
  type PanoMode,
} from './panorama.js';

/** The pre-estimate cost shown per mode (refined by the bridge estimate). */
export const MODE_ESTIMATE_BUZZ: Record<PanoMode, number> = {
  seamless: PANORAMA_ESTIMATE_BUZZ,
  zimage: ZIMAGE_ESTIMATE_BUZZ,
  flux2: FLUX2_ESTIMATE_BUZZ,
  qwen: QWEN_ESTIMATE_BUZZ,
  hosted: PANORAMA_ESTIMATE_BUZZ,
};

/** Which server-side recipe each customComfy mode translates to. */
export const MODE_ENGINE: Record<Exclude<PanoMode, 'hosted'>, PanoEngine> = {
  seamless: 'sdxl',
  zimage: 'zimage-turbo',
  flux2: 'flux2-klein',
  qwen: 'qwen-image',
};

const MODE_NODE_LABELS: Record<PanoMode, Record<string, string>> = {
  seamless: PANO_NODE_LABELS,
  zimage: ZIMAGE_NODE_LABELS,
  flux2: FLUX2_NODE_LABELS,
  qwen: QWEN_NODE_LABELS,
  hosted: STANDARD_NODE_LABELS,
};

/** What the controller needs from the host bridge. */
export interface WorkflowBridge {
  estimate(body: WorkflowBody): Promise<BlockWorkflowSnapshot>;
  /** Where submit/poll/cancel go — a kit gateway over the same transport. */
  gateway: RunGateway;
}

export interface PanoRequest {
  prompt: string;
  seed?: number;
  mode: PanoMode;
  accountType?: BuzzAccountType;
  /** SDXL checkpoint override (picker result); ignored by the DiT modes. */
  checkpoint?: PanoCheckpoint;
}

export interface ControllerState {
  phase: GenPhase;
  mode: PanoMode;
  estimatedCost: number | null;
  actualCost: number | null;
  /** Every blob url seen so far — customComfy blobs stream in incrementally. */
  imageUrls: string[];
  imageUrl: string | null;
  error: string | null;
  workflowId: string | null;
  startedAt: number | null;
  spentAccountType: BuzzAccountType | null;
  /** The kit run state — everything the run UI elements render. */
  run: RunState | null;
}

const INITIAL: ControllerState = {
  phase: 'idle',
  mode: 'seamless',
  estimatedCost: PANORAMA_ESTIMATE_BUZZ,
  actualCost: null,
  imageUrls: [],
  imageUrl: null,
  error: null,
  workflowId: null,
  startedAt: null,
  spentAccountType: null,
  run: null,
};

export class GenerationController {
  private state: ControllerState = { ...INITIAL };
  private readonly listeners = new Set<(s: ControllerState) => void>();
  private run: RunController | null = null;
  private runUnsubscribe: (() => void) | null = null;

  constructor(private readonly bridge: WorkflowBridge) {}

  getState(): ControllerState {
    return this.state;
  }

  subscribe(listener: (s: ControllerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Real server-side cancel of the in-flight run (billed elapsed-only). */
  cancel(): void {
    void this.run?.cancel();
  }

  /** Abandon the in-flight run's client machinery (the workflow keeps running). */
  stopPolling(): void {
    this.disposeRun();
  }

  reset(): void {
    this.disposeRun();
    this.set({ ...INITIAL, mode: this.state.mode });
  }

  async generate(req: PanoRequest): Promise<void> {
    this.disposeRun();
    this.set({
      ...INITIAL,
      mode: req.mode,
      estimatedCost: MODE_ESTIMATE_BUZZ[req.mode],
      phase: 'estimating',
      startedAt: Date.now(),
    });

    // The proposed pano360 kind rides through the same transport untyped —
    // the bridge's published WorkflowBody union is textToImage-only today.
    const body =
      req.mode === 'hosted'
        ? buildHostedBody(req.prompt, req.seed, req.accountType, req.checkpoint)
        : (buildPanoBody(req.prompt, req.seed, req.accountType, {
            engine: MODE_ENGINE[req.mode],
            ...(req.checkpoint !== undefined && { checkpoint: req.checkpoint }),
          }) as unknown as WorkflowBody);

    try {
      const est = await this.bridge.estimate(body);
      if (est.status === 'failed' || est.error) {
        const estPhase = phaseForError(est.error);
        if (estPhase === 'insufficient' || estPhase === 'account-rejected') {
          this.set({ phase: estPhase, error: est.error ?? 'Not enough Buzz.' });
          return;
        }
        this.set({ estimatedCost: null });
      } else {
        this.set({ estimatedCost: est.cost?.total ?? null });
      }
    } catch {
      this.set({ estimatedCost: null });
    }

    this.set({ phase: 'submitting' });
    const run = new RunController({
      gateway: this.bridge.gateway,
      nodeLabels: MODE_NODE_LABELS[req.mode],
    });
    this.run = run;
    this.runUnsubscribe = run.subscribe((runState) => this.onRunState(runState));
    await run.start(body);
  }

  private onRunState(run: RunState): void {
    const patch: Partial<ControllerState> = { run };
    if (run.workflowId) patch.workflowId = run.workflowId;
    if (run.imageUrls.length > this.state.imageUrls.length) {
      patch.imageUrls = run.imageUrls;
      patch.imageUrl = run.imageUrls[0] ?? null;
    }

    switch (run.phase) {
      case 'idle':
        break;
      case 'submitting':
        patch.phase = 'submitting';
        break;
      case 'queued':
      case 'preparing':
      case 'starting':
      case 'running':
        patch.phase = 'polling';
        break;
      case 'succeeded':
        patch.phase = 'succeeded';
        patch.actualCost = run.settled?.total ?? this.state.actualCost;
        patch.spentAccountType = (run.settled?.spentAccountType as BuzzAccountType) ?? null;
        break;
      case 'failed': {
        const message = run.error?.message ?? 'Generation failed.';
        patch.phase = phaseForError(message);
        patch.error = message;
        patch.actualCost = run.settled?.total ?? this.state.actualCost;
        break;
      }
      case 'canceled':
        patch.phase = 'canceled';
        patch.actualCost = run.settled?.total ?? this.state.actualCost;
        break;
    }
    this.set(patch);
  }

  private disposeRun(): void {
    this.runUnsubscribe?.();
    this.runUnsubscribe = null;
    this.run?.dispose();
    this.run = null;
  }

  private set(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
