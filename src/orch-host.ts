// Dev-only ORCHESTRATOR host (`npm run dev:orch`): an OPTIONAL local fallback
// that answers generation messages with REAL orchestrator calls (the templates
// in panorama.ts) — for local dev WITHOUT the deployed platform bridge. The
// real bridge now owns the bounded `customComfy` recipe (civitai #3228), so
// this is no longer the only path the seamless modes work through.
//
// It accepts the real-bridge `customComfy` body (translating it back to the
// internal `PanoBody` the templates consume) AND the legacy `pano360`/hosted
// bodies. Requests go same-origin to `/orch/...` — the Vite proxy injects the
// dev's API token SERVER-SIDE, so it never reaches client JS. Submits SPEND
// REAL BUZZ on the token owner.

import { mapDocToDetail, type RunDetail } from '@civitai/comfy-run-kit';

import {
  FLUX2_ESTIMATE_BUZZ,
  GEN_STEP_NAME,
  PANORAMA_ESTIMATE_BUZZ,
  QWEN_ESTIMATE_BUZZ,
  ZIMAGE_ESTIMATE_BUZZ,
  buildDitSeamlessTemplate,
  buildSeamlessTemplate,
  buildStandardTemplate,
  customComfyToPanoBody,
  extractLayerAir,
  isCustomComfyBody,
  isHostedBody,
  mapWorkflowToSnapshot,
  type HostedBodyLike,
  type OrchestratorWorkflowDoc,
  type PanoBody,
  type PanoEngine,
} from './panorama.js';
import { clearCachedLayerAir, getCachedLayerAir, setCachedLayerAir } from './nodepack.js';

const INTERCEPTED = new Set([
  'ESTIMATE_WORKFLOW',
  'SUBMIT_WORKFLOW',
  'POLL_WORKFLOW',
  'CANCEL_WORKFLOW',
  'GET_BUZZ_BALANCE',
  'OPEN_CHECKPOINT_PICKER',
]);

/** The overlay's catalog filter wants a baseModel NAME, not an ecosystem key. */
const BASE_MODEL_GROUP_TO_NAME: Record<string, string> = { SDXL: 'SDXL 1.0' };

const ORCH_BASE = '/orch/v2/consumer/workflows';

/** Long-poll window for GETs; older orchestrations 400 on an integer wait. */
const POLL_WAIT_SECONDS = 5;
let waitSupported = true;

/** Workflow ids this host created — polls for anything else go to the mock host. */
const orchWorkflowIds = new Set<string>();

/** Reply to the block the same way the SDK mock host does. */
function dispatchToBlock(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin: window.location.origin }));
}

function failureSnapshot(workflowId: string, err: unknown) {
  return {
    workflowId,
    status: 'failed' as const,
    error: err instanceof Error ? err.message : String(err),
  };
}

async function orchFetch(path: string, init?: RequestInit): Promise<OrchestratorWorkflowDoc> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Orchestrator ${res.status}: ${text.slice(0, 300) || res.statusText}`);
  }
  return (await res.json()) as OrchestratorWorkflowDoc;
}

/** Make the traceUrl fetchable same-origin through the Vite `/orch` proxy. */
function rewriteTraceUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.pathname.startsWith('/v2/consumer/')) {
      return `/orch${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // opaque url — leave it for the tailer to try directly
  }
  return url;
}

/** The rich per-poll detail a real platform bridge would attach server-side. */
function enrich(doc: OrchestratorWorkflowDoc): RunDetail {
  return mapDocToDetail(doc, { stepName: GEN_STEP_NAME, rewriteTraceUrl });
}

async function fetchWorkflowDoc(workflowId: string): Promise<OrchestratorWorkflowDoc> {
  const base = `${ORCH_BASE}/${encodeURIComponent(workflowId)}`;
  if (waitSupported) {
    const res = await fetch(`${base}?wait=${POLL_WAIT_SECONDS}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.status !== 400) {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Orchestrator ${res.status}: ${text.slice(0, 300) || res.statusText}`);
      }
      return (await res.json()) as OrchestratorWorkflowDoc;
    }
    waitSupported = false;
    await res.text().catch(() => '');
  }
  return orchFetch(base);
}

/** Remember a freshly captured install layer so the next submit is single-step. */
function captureLayerAir(doc: OrchestratorWorkflowDoc): void {
  const layerAir = extractLayerAir(doc);
  if (layerAir) setCachedLayerAir(layerAir);
}

async function submitSdxl(body: PanoBody): Promise<OrchestratorWorkflowDoc> {
  const cachedLayer = getCachedLayerAir();
  try {
    return await orchFetch(ORCH_BASE, {
      method: 'POST',
      body: JSON.stringify(buildSeamlessTemplate(body, cachedLayer)),
    });
  } catch (err) {
    // A stale cached layer AIR fails at submit/enqueue — drop it and let the
    // snapshot step re-capture (a server-side cache hit when still valid).
    if (!cachedLayer) throw err;
    clearCachedLayerAir();
    return await orchFetch(ORCH_BASE, {
      method: 'POST',
      body: JSON.stringify(buildSeamlessTemplate(body)),
    });
  }
}

async function handleSubmit(requestId: string, body: PanoBody | HostedBodyLike): Promise<void> {
  try {
    // The DiT engines and standard are all stock nodes: single step, no
    // nodepack layer to manage. Only the SDXL wrap needs the layer-cache dance.
    const doc = isHostedBody(body)
      ? await orchFetch(ORCH_BASE, {
          method: 'POST',
          body: JSON.stringify(buildStandardTemplate(body)),
        })
      : body.engine !== undefined && body.engine !== 'sdxl'
        ? await orchFetch(ORCH_BASE, {
            method: 'POST',
            body: JSON.stringify(buildDitSeamlessTemplate(body.engine, body)),
          })
        : await submitSdxl(body);
    if (doc.id) orchWorkflowIds.add(doc.id);
    captureLayerAir(doc);
    dispatchToBlock({
      type: 'WORKFLOW_SUBMITTED',
      payload: { requestId, snapshot: mapWorkflowToSnapshot(doc), detail: enrich(doc) },
    });
  } catch (err) {
    dispatchToBlock({
      type: 'WORKFLOW_SUBMITTED',
      payload: { requestId, snapshot: failureSnapshot('wf_submit_error', err) },
    });
  }
}

async function handlePoll(requestId: string, workflowId: string): Promise<void> {
  try {
    const doc = await fetchWorkflowDoc(workflowId);
    captureLayerAir(doc);
    if (doc.status === 'failed') {
      // A workflow that died on the layer resource means the cache went stale
      // mid-rollover; clear it so the NEXT generate re-snapshots.
      const stepError = (doc.steps ?? []).find((s) => s.metadata?.error)?.metadata?.error ?? '';
      if (/layer|nodepack|resource/i.test(stepError) && getCachedLayerAir()) clearCachedLayerAir();
    }
    dispatchToBlock({
      type: 'WORKFLOW_STATUS',
      payload: { requestId, snapshot: mapWorkflowToSnapshot(doc), detail: enrich(doc) },
    });
  } catch (err) {
    dispatchToBlock({
      type: 'WORKFLOW_STATUS',
      payload: { requestId, snapshot: failureSnapshot(workflowId, err) },
    });
  }
}

async function handleCancel(requestId: string, workflowId: string): Promise<void> {
  const reply = (doc: OrchestratorWorkflowDoc) =>
    dispatchToBlock({
      type: 'WORKFLOW_CANCELED',
      payload: { requestId, snapshot: mapWorkflowToSnapshot(doc), detail: enrich(doc) },
    });
  try {
    const res = await fetch(`${ORCH_BASE}/${encodeURIComponent(workflowId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'canceled' }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Orchestrator ${res.status}: ${text.slice(0, 300) || res.statusText}`);
    }
    let doc: OrchestratorWorkflowDoc | null = null;
    try {
      doc = (await res.json()) as OrchestratorWorkflowDoc;
    } catch {
      doc = null;
    }
    reply(doc && typeof doc === 'object' && doc.status ? doc : await fetchWorkflowDoc(workflowId));
  } catch {
    // Cancel didn't land — reply with the CURRENT doc so the kit re-enables
    // the button and keeps polling (a failure snapshot would mislabel a
    // possibly-still-running workflow as failed).
    try {
      reply(await fetchWorkflowDoc(workflowId));
    } catch (err) {
      dispatchToBlock({
        type: 'WORKFLOW_CANCELED',
        payload: { requestId, snapshot: failureSnapshot(workflowId, err) },
      });
    }
  }
}

const ENGINE_ESTIMATE_BUZZ: Record<PanoEngine, number> = {
  sdxl: PANORAMA_ESTIMATE_BUZZ,
  'zimage-turbo': ZIMAGE_ESTIMATE_BUZZ,
  'flux2-klein': FLUX2_ESTIMATE_BUZZ,
  'qwen-image': QWEN_ESTIMATE_BUZZ,
};

function handleEstimate(requestId: string, body: PanoBody | HostedBodyLike): void {
  // Post-paid billing has no exact pre-price — report the per-engine approximation.
  const total = isHostedBody(body)
    ? PANORAMA_ESTIMATE_BUZZ
    : ENGINE_ESTIMATE_BUZZ[body.engine ?? 'sdxl'];
  dispatchToBlock({
    type: 'ESTIMATE_RESULT',
    payload: {
      requestId,
      snapshot: {
        workflowId: 'wf_estimate',
        status: 'pending',
        cost: { total },
      },
    },
  });
}

async function handleCheckpointPicker(
  requestId: string,
  payload: { baseModelGroup?: string; currentVersionId?: number },
): Promise<void> {
  const reply = (selected?: unknown) =>
    dispatchToBlock({
      type: 'CHECKPOINT_PICKER_RESULT',
      payload: { requestId, ...(selected !== undefined && selected !== null ? { selected } : {}) },
    });
  try {
    // Public catalog via the `/api` proxy, no token. A pick is discovery-only;
    // a real bridge re-validates the id at submit.
    const { openPickerOverlay } = await import('@civitai/blocks-react/testing');
    const group = payload.baseModelGroup;
    openPickerOverlay({
      type: 'Checkpoint',
      baseUrl: '',
      token: null,
      fetchImpl: (...args) => fetch(...args),
      ...(group !== undefined && { baseModelGroup: BASE_MODEL_GROUP_TO_NAME[group] ?? group }),
      ...(payload.currentVersionId !== undefined && {
        currentVersionId: payload.currentVersionId,
      }),
      onResolve: (selection) => reply(selection?.selected),
    });
  } catch {
    reply();
  }
}

function handleBalance(requestId: string): void {
  // The orchestrator token can't read the viewer's wallet, and the mock host's
  // synthetic numbers would sit next to REAL spend — report honestly instead.
  dispatchToBlock({
    type: 'BUZZ_BALANCE_RESULT',
    payload: {
      requestId,
      error: 'Buzz balance is not readable in dev:orch (spend is still real).',
    },
  });
}

interface BridgeMessage {
  type?: string;
  payload?: { requestId?: string; body?: unknown; workflowId?: string };
}

const isPanoBody = (body: unknown): body is PanoBody =>
  typeof body === 'object' && body !== null && (body as { kind?: unknown }).kind === 'pano360';

/**
 * Reduce any body this host can serve to the internal generation shape:
 * a real-bridge `customComfy` recipe body → `PanoBody`; a legacy `pano360`
 * body → itself; a hosted `textToImage` body → itself. `null` = not ours
 * (handed to the mock host).
 */
function normalizeGenBody(body: unknown): PanoBody | HostedBodyLike | null {
  if (isHostedBody(body)) return body;
  if (isCustomComfyBody(body)) return customComfyToPanoBody(body);
  if (isPanoBody(body)) return body;
  return null;
}

/** True when this host answers the message; false hands it to the mock host. */
function handleIntercepted(data: BridgeMessage): boolean {
  const requestId = data.payload?.requestId;
  if (typeof requestId !== 'string') return false;

  if (data.type === 'ESTIMATE_WORKFLOW') {
    const body = normalizeGenBody(data.payload?.body);
    if (body) {
      handleEstimate(requestId, body);
      return true;
    }
  }
  if (data.type === 'OPEN_CHECKPOINT_PICKER') {
    void handleCheckpointPicker(
      requestId,
      data.payload as { baseModelGroup?: string; currentVersionId?: number },
    );
    return true;
  }
  if (data.type === 'SUBMIT_WORKFLOW') {
    const body = normalizeGenBody(data.payload?.body);
    if (body) {
      void handleSubmit(requestId, body);
      return true;
    }
  }
  if (data.type === 'POLL_WORKFLOW' || data.type === 'CANCEL_WORKFLOW') {
    const workflowId = data.payload?.workflowId;
    if (typeof workflowId === 'string' && orchWorkflowIds.has(workflowId)) {
      if (data.type === 'POLL_WORKFLOW') void handlePoll(requestId, workflowId);
      else void handleCancel(requestId, workflowId);
      return true;
    }
  }
  if (data.type === 'GET_BUZZ_BALANCE') {
    handleBalance(requestId);
    return true;
  }
  return false;
}

/**
 * The mock host delivers the block's outbound messages by patching
 * `window.parent.postMessage` (they never become real `message` events), so
 * interception must wrap that same seam — call AFTER the mock host installs.
 */
export function installOrchestratorHost(): () => void {
  const mockParent = window.parent;
  const wrapped = Object.create(mockParent) as Window;
  Object.defineProperty(wrapped, 'postMessage', {
    configurable: true,
    value: (data: unknown, ...rest: unknown[]) => {
      const msg = data as BridgeMessage | undefined;
      if (msg?.type && INTERCEPTED.has(msg.type) && handleIntercepted(msg)) return;
      (mockParent.postMessage as (...args: unknown[]) => void).call(mockParent, data, ...rest);
    },
  });
  Object.defineProperty(window, 'parent', { configurable: true, get: () => wrapped });
  return () => {
    Object.defineProperty(window, 'parent', { configurable: true, get: () => mockParent });
  };
}
