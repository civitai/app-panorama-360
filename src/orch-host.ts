// Dev-only ORCHESTRATOR host mode (`npm run dev:orch`).
//
// The platform's block bridge (civitai `blocks.submitWorkflow`) supports only
// `kind: 'textToImage'` today, so the real host can't run this app's `pano360`
// bodies yet. This module stands in for the missing platform piece during
// development: it intercepts the workflow bridge messages BEFORE the SDK mock
// host sees them and answers `pano360` bodies with REAL orchestrator calls —
// translating the bounded body into the server-owned customComfy template
// (panorama.ts) exactly as the platform's blocks.router would. It also answers
// CANCEL_WORKFLOW for its own workflows with a real PUT {status: canceled}
// (the orchestrator interrupts ComfyUI mid-render; post-paid billing charges
// only elapsed runtime). `textToImage` (hosted-mode) bodies are FORWARDED to
// the mock host, so the mode toggle stays exercisable in one orch session
// without double-spending.
//
// Enrichment: every workflow reply carries a `detail: RunDetail` field beside
// the flat snapshot (extra payload fields survive postMessage) — queue
// position, preparing %, live usage, and a same-origin-rewritten traceUrl the
// kit's trace tailer can stream. This is exactly the enrichment a future real
// platform bridge would attach; the kit degrades gracefully without it.
//
// GET_BUZZ_BALANCE is answered with an honest "not readable" error instead of
// forwarding to the mock host — never show fake balance numbers next to real
// spend (illusion-factory precedent). Everything else (BLOCK_INIT, tokens,
// consent, theme) stays on the SDK mock host mounted by the harness.
//
// The mock host delivers the block's OUTBOUND messages by patching
// `window.parent.postMessage` (they never become real window `message`
// events), so interception must wrap that same seam: installOrchestratorHost()
// replaces `window.parent` with a delegate whose postMessage handles the pano
// workflow messages and forwards everything else to the mock host's patched
// parent. It must run AFTER the mock host installs.
//
// Money path: requests go SAME-ORIGIN to `/orch/...`; the Vite dev proxy
// forwards them to the orchestrator and injects the dev's API token
// SERVER-SIDE (vite.config.ts) — the token never reaches client JS. Submits
// SPEND REAL BUZZ on the token owner's account (~30-90 Buzz per panorama,
// billed post-paid at 1 Buzz per GPU-second).
//
// Nodepack layers: the first submit goes 2-step (comfyNodepackSnapshot +
// customComfy via $ref); once a poll shows the captured layer AIR it's cached
// (nodepack.ts) and later submits go single-step. A failed single-step submit
// invalidates the cache and retries 2-step once — the layer is image-specific
// and goes stale when the worker fleet's comfy image rolls over.

import { mapDocToDetail, type RunDetail } from '@civitai/comfy-run-kit';

import {
  GEN_STEP_NAME,
  PANORAMA_ESTIMATE_BUZZ,
  buildSeamlessTemplate,
  extractLayerAir,
  mapWorkflowToSnapshot,
  type OrchestratorWorkflowDoc,
  type PanoBody,
} from './panorama.js';
import { clearCachedLayerAir, getCachedLayerAir, setCachedLayerAir } from './nodepack.js';

const INTERCEPTED = new Set([
  'ESTIMATE_WORKFLOW',
  'SUBMIT_WORKFLOW',
  'POLL_WORKFLOW',
  'CANCEL_WORKFLOW',
  'GET_BUZZ_BALANCE',
]);

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

async function handleSubmit(requestId: string, body: PanoBody): Promise<void> {
  try {
    const cachedLayer = getCachedLayerAir();
    let doc: OrchestratorWorkflowDoc;
    try {
      doc = await orchFetch(ORCH_BASE, {
        method: 'POST',
        body: JSON.stringify(buildSeamlessTemplate(body, cachedLayer)),
      });
    } catch (err) {
      // A stale cached layer AIR fails at submit/enqueue — drop it and let the
      // snapshot step re-capture (a server-side cache hit when still valid).
      if (!cachedLayer) throw err;
      clearCachedLayerAir();
      doc = await orchFetch(ORCH_BASE, {
        method: 'POST',
        body: JSON.stringify(buildSeamlessTemplate(body)),
      });
    }
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

function handleEstimate(requestId: string): void {
  // customComfy bills post-paid (1 Buzz per GPU-second) — there is no exact
  // pre-price. Report the tuned approximation the button shows.
  dispatchToBlock({
    type: 'ESTIMATE_RESULT',
    payload: {
      requestId,
      snapshot: {
        workflowId: 'wf_estimate',
        status: 'pending',
        cost: { total: PANORAMA_ESTIMATE_BUZZ },
      },
    },
  });
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
 * Decide whether this host answers the message (true) or the mock host should
 * (false): pano360 estimates/submits and the balance probe are ours;
 * polls/cancels are ours only for workflows we created; everything else —
 * including hosted-mode textToImage bodies — belongs to the mock host.
 */
function handleIntercepted(data: BridgeMessage): boolean {
  const requestId = data.payload?.requestId;
  if (typeof requestId !== 'string') return false;

  if (data.type === 'ESTIMATE_WORKFLOW' && isPanoBody(data.payload?.body)) {
    handleEstimate(requestId);
    return true;
  }
  if (data.type === 'SUBMIT_WORKFLOW' && isPanoBody(data.payload?.body)) {
    void handleSubmit(requestId, data.payload?.body as PanoBody);
    return true;
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
 * Wrap the (mock-host-patched) `window.parent` so pano workflow messages are
 * answered here and everything else delegates to the mock host. Call AFTER
 * the mock host has installed (see the header comment); returns the restore.
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
