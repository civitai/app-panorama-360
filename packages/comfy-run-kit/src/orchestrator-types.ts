// The consumer-API workflow document (GET /v2/consumer/workflows/{id}) and the
// single mapping from it to the kit's snapshot + RunDetail. Every poll triggers
// a live server-side refresh, so queuePosition / estimatedProgressRate /
// output.usage on this doc are current, not cached.

import type {
  GatewayResult,
  RunDetail,
  RunSnapshot,
  SnapshotStatus,
  UsageInfo,
  WalletTransaction,
} from './types.js';

export interface OrchJobQueuePosition {
  precedingJobs?: number;
  startAt?: string;
  completeAt?: string;
}

export interface OrchJob {
  id?: string;
  status?: string;
  queuePosition?: OrchJobQueuePosition;
  /** 0–1. Download fraction while status is "Preparing"; compute estimate after. */
  estimatedProgressRate?: number;
  startedAt?: string;
  completedAt?: string;
}

export interface OrchBlob {
  url?: string;
  available?: boolean;
}

export interface OrchStepOutput {
  blobs?: OrchBlob[];
  usage?: UsageInfo;
  traceUrl?: string;
  results?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface OrchStep {
  name?: string;
  $type?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  estimatedProgressRate?: number;
  jobs?: OrchJob[] | null;
  output?: OrchStepOutput;
  metadata?: { error?: string; [key: string]: unknown };
}

export interface OrchTransaction extends WalletTransaction {
  type?: string;
}

export interface OrchWorkflowDoc {
  id?: string;
  status?: string;
  cost?: { total?: number };
  transactions?: { list?: OrchTransaction[]; insufficientBuzz?: unknown };
  steps?: OrchStep[];
}

const STATUS_MAP: Record<string, SnapshotStatus> = {
  processing: 'processing',
  succeeded: 'succeeded',
  failed: 'failed',
  expired: 'expired',
  canceled: 'canceled',
};

/** Orchestrator workflow status → the flattened bridge snapshot status. */
export function mapDocToSnapshot(doc: OrchWorkflowDoc): RunSnapshot {
  const status = STATUS_MAP[doc.status ?? ''] ?? 'pending';
  const snapshot: RunSnapshot = { workflowId: doc.id ?? '', status };
  const total = doc.cost?.total;
  if (typeof total === 'number') snapshot.cost = { total };
  const urls = (doc.steps ?? [])
    .flatMap((s) => s.output?.blobs ?? [])
    .map((b) => b.url)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (urls.length > 0) snapshot.imageUrls = urls;
  if (status === 'failed' || status === 'expired') {
    snapshot.error =
      (doc.steps ?? []).find((s) => s.metadata?.error)?.metadata?.error ??
      `Generation ${status}.`;
  }
  return snapshot;
}

export interface MapDetailOptions {
  /** Pick this step by name; default = the most detail-bearing step. */
  stepName?: string;
  /** Make traceUrl fetchable from the consumer's origin (proxy rewrite). */
  rewriteTraceUrl?: (url: string) => string;
}

function pickStep(doc: OrchWorkflowDoc, stepName?: string): OrchStep | undefined {
  const steps = doc.steps ?? [];
  if (stepName) {
    const named = steps.find((s) => s.name === stepName);
    if (named) return named;
  }
  return (
    steps.find((s) => s.output?.usage || s.output?.traceUrl || (s.jobs?.length ?? 0) > 0) ??
    steps[steps.length - 1]
  );
}

export function mapDocToDetail(
  doc: OrchWorkflowDoc,
  options: MapDetailOptions = {},
): RunDetail {
  const detail: RunDetail = {};
  if (doc.status) detail.orchStatus = doc.status;

  const step = pickStep(doc, options.stepName);
  if (step) {
    if (typeof step.estimatedProgressRate === 'number') {
      detail.stepProgressRate = step.estimatedProgressRate;
    }

    const jobs = step.jobs ?? [];
    if (jobs.length > 0) {
      // The active job: a preparing one wins (its rate is the download %),
      // otherwise the furthest-along one.
      const preparing = jobs.filter((j) => j.status?.toLowerCase() === 'preparing');
      const pool = preparing.length > 0 ? preparing : jobs;
      const job = pool.reduce((a, b) =>
        (b.estimatedProgressRate ?? -1) > (a.estimatedProgressRate ?? -1) ? b : a,
      );
      detail.job = {
        ...(job.status !== undefined && { status: job.status }),
        ...(typeof job.estimatedProgressRate === 'number' && {
          progressRate: job.estimatedProgressRate,
        }),
        ...(job.startedAt !== undefined && { startedAt: job.startedAt }),
      };

      const queued = jobs
        .map((j) => j.queuePosition)
        .filter((q): q is OrchJobQueuePosition => !!q && typeof q.precedingJobs === 'number');
      if (queued.length > 0) {
        const nearest = queued.reduce((a, b) =>
          (b.precedingJobs ?? Infinity) < (a.precedingJobs ?? Infinity) ? b : a,
        );
        detail.queue = {
          precedingJobs: nearest.precedingJobs as number,
          ...(nearest.startAt !== undefined && { startAt: nearest.startAt }),
        };
      }
    }

    const usage = step.output?.usage;
    if (usage) detail.usage = usage;

    const traceUrl = step.output?.traceUrl;
    if (typeof traceUrl === 'string' && traceUrl.length > 0) {
      detail.traceUrl = options.rewriteTraceUrl ? options.rewriteTraceUrl(traceUrl) : traceUrl;
    }
  }

  if (typeof doc.cost?.total === 'number') detail.cost = { total: doc.cost.total };
  const transactions = doc.transactions?.list;
  if (Array.isArray(transactions) && transactions.length > 0) {
    detail.transactions = transactions;
  }
  return detail;
}

export function docToGatewayResult(
  doc: OrchWorkflowDoc,
  options: MapDetailOptions = {},
): GatewayResult {
  return { snapshot: mapDocToSnapshot(doc), detail: mapDocToDetail(doc, options) };
}
