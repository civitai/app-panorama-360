// Public contracts for the customComfy run experience: the unified RunState
// the UI renders, and the RunGateway seam that abstracts WHERE workflow calls
// go (direct consumer API vs the block postMessage bridge).

export type RunPhase =
  | 'idle'
  | 'submitting'
  | 'queued'
  | 'preparing'
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

/**
 * Why a run ended `canceled`. The orchestrator's mid-run out-of-buzz stop
 * arrives as the same terminal status as a user cancel, so this is inferred:
 * 'user' when cancel() was called, 'outOfBuzz' when billing was observed
 * running, 'unknown' otherwise.
 */
export type CanceledReason = 'user' | 'outOfBuzz' | 'unknown';

export interface WalletTransaction {
  accountType?: string;
  amount?: number;
}

/** `steps[].output.usage` — accrues live on every poll for post-paid steps. */
export interface UsageInfo {
  buzzPerSecond?: number;
  estimatedCost?: number;
  runtimeSeconds?: number;
  startedAt?: string;
  computedAt?: string;
}

export interface BuzzMeterState {
  /** Buzz spent so far — extrapolated between polls, settled at terminal. */
  live: number | null;
  rate: number | null;
  settled: boolean;
}

export interface QueueInfo {
  ahead: number;
  etaStart: string | null;
}

export interface SamplerProgress {
  step: number;
  total: number;
  /** 0–100 */
  pct: number;
}

export interface RunError {
  message: string;
  traceback?: string;
}

export interface RunSettled {
  total: number | null;
  transactions: WalletTransaction[];
  /** Primary funding pool, when the host reports it (bridge snapshots do). */
  spentAccountType: string | null;
}

export interface RunState {
  phase: RunPhase;
  workflowId: string | null;
  /** Local ms timestamp when the run started (submit sent). */
  startedAt: number | null;
  elapsedSeconds: number;
  queue: QueueInfo | null;
  /** Model-download fraction (0–1) while the worker prepares. */
  prepProgress: number | null;
  sampler: SamplerProgress | null;
  currentNode: string | null;
  buzz: BuzzMeterState;
  previewUrl: string | null;
  logs: string[];
  imageUrls: string[];
  error: RunError | null;
  cancelPending: boolean;
  canceledReason: CanceledReason | null;
  settled: RunSettled | null;
}

export const INITIAL_RUN_STATE: RunState = {
  phase: 'idle',
  workflowId: null,
  startedAt: null,
  elapsedSeconds: 0,
  queue: null,
  prepProgress: null,
  sampler: null,
  currentNode: null,
  buzz: { live: null, rate: null, settled: false },
  previewUrl: null,
  logs: [],
  imageUrls: [],
  error: null,
  cancelPending: false,
  canceledReason: null,
  settled: null,
};

/** Mirrors the block bridge's BlockWorkflowSnapshot status union. */
export type SnapshotStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'canceled';

export interface RunSnapshot {
  workflowId: string;
  status: SnapshotStatus;
  cost?: { total: number };
  imageUrls?: string[];
  error?: string;
  spentAccountType?: string;
}

export const TERMINAL_SNAPSHOT_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'expired',
  'canceled',
]);

/**
 * Rich per-poll detail the flattened block snapshot cannot carry (it has no
 * progress/queue/usage fields). A host with orchestrator access attaches this
 * BESIDE the snapshot on its bridge replies (extra fields survive the
 * postMessage clone); when absent the run degrades to elapsed-time + an
 * indeterminate bar. This type doubles as the proposed shape for a future
 * platform-bridge enrichment.
 */
export interface RunDetail {
  orchStatus?: string;
  queue?: { precedingJobs?: number; startAt?: string };
  job?: { status?: string; progressRate?: number; startedAt?: string };
  stepProgressRate?: number;
  usage?: UsageInfo;
  /** Must be fetchable from the app's origin (host rewrites/proxies it). */
  traceUrl?: string;
  cost?: { total?: number };
  transactions?: WalletTransaction[];
}

export interface GatewayResult {
  snapshot: RunSnapshot;
  detail?: RunDetail;
}

/** Where workflow calls go: direct consumer API or the block bridge. */
export interface RunGateway {
  submit(body: unknown): Promise<GatewayResult>;
  poll(workflowId: string): Promise<GatewayResult>;
  cancel(workflowId: string): Promise<GatewayResult>;
}
