// Pure derivation of the run phase + progress fields from one poll result.
// With detail: queued → preparing (download %) → starting → running.
// Without detail (a host that only relays the flat snapshot): pending/processing
// degrade to queued/running with indeterminate progress. Terminal statuses map
// directly; `canceledReason` is the controller's call (it knows who canceled).

import {
  TERMINAL_SNAPSHOT_STATUSES,
  type GatewayResult,
  type RunPhase,
  type RunState,
} from './types.js';

export function deriveRunPatch(prev: RunState, result: GatewayResult): Partial<RunState> {
  const { snapshot, detail } = result;
  const patch: Partial<RunState> = {};

  if (snapshot.workflowId) patch.workflowId = snapshot.workflowId;
  if (snapshot.imageUrls && snapshot.imageUrls.length > prev.imageUrls.length) {
    patch.imageUrls = snapshot.imageUrls;
  }

  if (TERMINAL_SNAPSHOT_STATUSES.has(snapshot.status)) {
    patch.phase = (snapshot.status === 'expired' ? 'failed' : snapshot.status) as RunPhase;
    patch.queue = null;
    patch.prepProgress = null;
    if (snapshot.status === 'failed' || snapshot.status === 'expired') {
      patch.error = {
        message: snapshot.error ?? prev.error?.message ?? 'Generation failed.',
        ...(prev.error?.traceback !== undefined && { traceback: prev.error.traceback }),
      };
    }
    patch.settled = {
      total: detail?.cost?.total ?? snapshot.cost?.total ?? detail?.usage?.estimatedCost ?? null,
      transactions: detail?.transactions ?? [],
      spentAccountType: snapshot.spentAccountType ?? null,
    };
    return patch;
  }

  if (!detail || Object.keys(detail).length === 0) {
    patch.phase = snapshot.status === 'processing' ? 'running' : 'queued';
    return patch;
  }

  const preparing = detail.job?.status?.toLowerCase() === 'preparing';
  if (detail.orchStatus?.toLowerCase() === 'processing') {
    if (preparing) {
      patch.phase = 'preparing';
      patch.prepProgress = detail.job?.progressRate ?? prev.prepProgress;
    } else {
      // "Running" needs REAL compute evidence — a trace frame already flipped
      // us. The orchestrator's derived job progressRate is elapsed-time-based
      // and nonzero the moment a worker claims the job, so it would show
      // "rendering" while the prompt still sits in the worker's queue.
      const computeEvidence = prev.phase === 'running' || prev.sampler !== null;
      patch.phase = computeEvidence ? 'running' : 'starting';
      patch.prepProgress = null;
    }
    patch.queue = null;
  } else {
    if (preparing) {
      patch.phase = 'preparing';
      patch.prepProgress = detail.job?.progressRate ?? prev.prepProgress;
    } else {
      patch.phase = 'queued';
    }
    if (detail.queue) {
      patch.queue = {
        ahead: detail.queue.precedingJobs ?? 0,
        etaStart: detail.queue.startAt ?? null,
      };
    }
  }

  return patch;
}
