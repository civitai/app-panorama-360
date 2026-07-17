// Pure Panorama Studio logic: scene presets, the proposed `pano360` workflow
// body, the hosted (textToImage) fallback body, and the customComfy translation
// the dev orchestrator host uses. No DOM — unit-tested in node (panorama.test.ts).

import type { BlockWorkflowSnapshot, BuzzAccountType, WorkflowBody } from '@civitai/app-sdk/blocks';
import type { OrchWorkflowDoc } from '@civitai/comfy-run-kit';

// ---------------------------------------------------------------------------
// The proposed block workflow body.
//
// The platform's block bridge (civitai `blocks.submitWorkflow`) currently
// accepts only `kind: 'textToImage'`. This app targets a future `pano360`
// kind: a SERVER-OWNED customComfy graph (seamless-wrap equirectangular
// panorama) where the block supplies only bounded knobs — never a raw Comfy
// graph. The dev-harness orchestrator host (orch-host.ts) implements exactly
// the translation the platform side would own: `buildSeamlessTemplate` below.
//
// Until that bridge exists, the app also offers HOSTED mode — a plain
// `textToImage` body the real host accepts today (same checkpoint + 360 LoRA,
// same 2:1 canvas) whose panorama has a visible seam where the edges meet.
// ---------------------------------------------------------------------------

export type PanoMode = 'seamless' | 'hosted';

export interface PanoBody {
  kind: 'pano360';
  /** The scene to wrap around the viewer (trigger words are added on translation). */
  prompt: string;
  /** Sampler seed; omit for random. */
  seed?: number;
  /** Preferred Buzz pool; omitted = host-chosen (Auto). */
  accountType?: BuzzAccountType;
}

// Juggernaut XL Ragnarok — SDXL checkpoint already proven on Civitai's comfy workers.
export const CHECKPOINT_MODEL_ID = 133005;
export const CHECKPOINT_VERSION_ID = 1759168;
export const CHECKPOINT_AIR = `urn:air:sdxl:checkpoint:civitai:${CHECKPOINT_MODEL_ID}@${CHECKPOINT_VERSION_ID}`;

// 360Redmond (SDXL v1.0) — the panorama LoRA. Trigger words: "360, 360view".
// The SDXL version is deliberate: the seamless-wrap trick patches UNet conv
// layers, which doesn't apply to the newer DiT-based versions of this LoRA.
export const LORA_MODEL_ID = 118025;
export const LORA_VERSION_ID = 143197;
export const LORA_AIR = `urn:air:sdxl:lora:civitai:${LORA_MODEL_ID}@${LORA_VERSION_ID}`;
export const LORA_STRENGTH = 0.6;
export const LORA_CLIP_STRENGTH = 1.0;

// spinagon/ComfyUI-seamless-tiling@1.0.0 — SeamlessTile (circular conv padding
// on the x axis so the left/right edges wrap) + CircularVAEDecode (same patch
// on the VAE so the decode doesn't reintroduce a seam). Node class_types and
// widget names verified against the pack source:
// https://github.com/spinagon/ComfyUI-seamless-tiling (SeamlessTile.py)
export const NODEPACK_AIR =
  'urn:air:comfy:nodepack:comfyregistry:spinagon/comfyui-seamless-tiling@1.0.0';

export const TRIGGER_WORDS = '360, 360view, ';
export const PROMPT_SUFFIX = ', ultra detailed, masterpiece, best quality';
export const NEGATIVE_PROMPT =
  'ugly, blurry, low quality, watermark, jpeg artifacts, deformed, text, border, frame';

// Equirectangular 2:1 canvas straight out of the sampler. 2048 is the block
// bridge's DIM_MAX, so hosted mode can use the identical size.
export const PANO_WIDTH = 2048;
export const PANO_HEIGHT = 1024;
export const PANO_STEPS = 30;
export const PANO_CFG = 7;
export const PANO_SAMPLER = 'dpmpp_2m';
export const PANO_SCHEDULER = 'karras';
/** The hosted (textToImage) body spells the sampler the platform way. */
export const HOSTED_SAMPLER = 'DPM++ 2M Karras';

export const PROMPT_MAX = 1500;

/**
 * Approximate cost shown before submit. customComfy bills post-paid
 * (1 Buzz per GPU-second); a 2048x1024 30-step SDXL run lands around 30-90.
 */
export const PANORAMA_ESTIMATE_BUZZ = 60;

export interface ScenePreset {
  id: string;
  label: string;
  prompt: string;
}

/**
 * Curated scenes that read well wrapped around the viewer: open spaces with a
 * clear horizon line, since equirectangular projection stretches the poles.
 */
export const SCENE_PRESETS: readonly ScenePreset[] = [
  {
    id: 'alpine',
    label: 'Alpine lake',
    prompt:
      'a concept art of an icy lake in the rockies, snowy peaks all around, magnificent, painterly, epic, majestic',
  },
  {
    id: 'beach',
    label: 'Tropical beach',
    prompt:
      'white sand tropical beach, turquoise lagoon, palm trees, distant sailboats, golden hour light',
  },
  {
    id: 'cyberpunk',
    label: 'Cyberpunk street',
    prompt:
      'neon-lit cyberpunk city street at night, rain-slick pavement, holographic billboards, dense skyscrapers',
  },
  {
    id: 'forest',
    label: 'Forest clearing',
    prompt:
      'sunlit forest clearing, tall ancient pines in every direction, wildflowers, volumetric light rays, morning mist',
  },
  {
    id: 'desert',
    label: 'Desert dunes',
    prompt:
      'endless golden desert dunes under a dramatic sunset sky, wind-carved sand ripples, lone dry acacia tree',
  },
  {
    id: 'station',
    label: 'Space station',
    prompt:
      'interior of a vast sci-fi space station hub, panoramic windows onto a nebula, walkways, soft blue lighting',
  },
];

/** Trim + clamp the scene prompt to the server cap. */
export function clampPrompt(raw: string): string {
  return raw.trim().slice(0, PROMPT_MAX);
}

export function buildPanoBody(
  prompt: string,
  seed?: number,
  accountType?: BuzzAccountType,
): PanoBody {
  const body: PanoBody = { kind: 'pano360', prompt: clampPrompt(prompt) };
  if (seed !== undefined) body.seed = seed;
  if (accountType) body.accountType = accountType;
  return body;
}

/** The full positive prompt: LoRA trigger words + scene + quality tail. */
export function positivePrompt(scene: string): string {
  return TRIGGER_WORDS + clampPrompt(scene) + PROMPT_SUFFIX;
}

// ---------------------------------------------------------------------------
// HOSTED mode — the `textToImage` body the real platform bridge accepts today.
// Same checkpoint + LoRA + canvas as seamless mode, but a plain generation:
// the panorama works in a 360 viewer yet shows a seam where the edges meet.
// ---------------------------------------------------------------------------

export function buildHostedBody(
  prompt: string,
  seed?: number,
  accountType?: BuzzAccountType,
): WorkflowBody {
  const body: WorkflowBody = {
    kind: 'textToImage',
    modelId: CHECKPOINT_MODEL_ID,
    modelVersionId: CHECKPOINT_VERSION_ID,
    additionalResources: [{ modelVersionId: LORA_VERSION_ID, strength: LORA_STRENGTH }],
    params: {
      prompt: positivePrompt(prompt),
      negativePrompt: NEGATIVE_PROMPT,
      width: PANO_WIDTH,
      height: PANO_HEIGHT,
      steps: PANO_STEPS,
      cfgScale: PANO_CFG,
      sampler: HOSTED_SAMPLER,
      quantity: 1,
    },
  };
  if (seed !== undefined) body.params.seed = seed;
  if (accountType) body.accountType = accountType;
  return body;
}

// ---------------------------------------------------------------------------
// SEAMLESS mode — the customComfy translation. What the PLATFORM would own once
// the block bridge grows a `pano360` kind; the dev orchestrator host stands in
// for it today (orch-host.ts).
//
// The wrap trick (from the A1111 seamless-tiling setting): SeamlessTile flips
// every UNet conv layer's x-axis padding to `circular`, so the sampler paints a
// canvas whose left/right edges are continuations of each other; then
// CircularVAEDecode applies the same patch to the VAE so decoding doesn't
// reintroduce an edge. y stays untouched — only the horizontal seam must wrap
// in an equirectangular panorama.
// ---------------------------------------------------------------------------

/** A ComfyUI /prompt graph: node-id keyed, class_type + inputs, link refs ['id', slot]. */
export type ComfyGraph = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;

export function buildSeamlessGraph(body: PanoBody): ComfyGraph {
  const seed = body.seed ?? Math.floor(Math.random() * 2_147_483_647);
  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: CHECKPOINT_AIR },
    },
    '2': {
      class_type: 'LoraLoader',
      inputs: {
        model: ['1', 0],
        clip: ['1', 1],
        lora_name: LORA_AIR,
        strength_model: LORA_STRENGTH,
        strength_clip: LORA_CLIP_STRENGTH,
      },
    },
    // "Modify in place" everywhere: the registry build of this pack deep-copies
    // on the "Make a copy" branch and modern ComfyUI model/VAE objects crash
    // under copy.deepcopy ("'NoneType' object is not callable" in __setstate__).
    // In-place patching is safe in a one-shot job container.
    '3': {
      class_type: 'SeamlessTile',
      inputs: { model: ['2', 0], tiling: 'x_only', copy_model: 'Modify in place' },
    },
    '4': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['2', 1], text: positivePrompt(body.prompt) },
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['2', 1], text: NEGATIVE_PROMPT },
    },
    '6': {
      class_type: 'EmptyLatentImage',
      inputs: { width: PANO_WIDTH, height: PANO_HEIGHT, batch_size: 1 },
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['3', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        seed,
        steps: PANO_STEPS,
        cfg: PANO_CFG,
        sampler_name: PANO_SAMPLER,
        scheduler: PANO_SCHEDULER,
        denoise: 1.0,
      },
    },
    // NOT CircularVAEDecode: it always deep-copies the VAE (same crash as
    // above, no in-place option). MakeCircularVAE + stock VAEDecode applies
    // the identical x-wrap patch without any copy.
    '8': {
      class_type: 'MakeCircularVAE',
      inputs: { vae: ['1', 2], tiling: 'x_only', copy_vae: 'Modify in place' },
    },
    '9': {
      class_type: 'VAEDecode',
      inputs: { samples: ['7', 0], vae: ['8', 0] },
    },
    '10': {
      class_type: 'SaveImage',
      inputs: { images: ['9', 0], filename_prefix: 'panorama' },
    },
  };
}

/** Friendly names for the graph's node ids — shown by the run-status element
 * as the trace's `executing` events walk the graph. */
export const PANO_NODE_LABELS: Record<string, string> = {
  '1': 'Loading checkpoint',
  '2': 'Applying 360 LoRA',
  '3': 'Applying seamless wrap',
  '4': 'Encoding prompt',
  '5': 'Encoding negative prompt',
  '6': 'Preparing canvas',
  '7': 'Sampling',
  '8': 'Patching VAE',
  '9': 'Decoding image',
  '10': 'Saving panorama',
};

export const SNAPSHOT_STEP_NAME = 'snapshot';
export const GEN_STEP_NAME = 'pano';

/**
 * Build the orchestrator `WorkflowTemplate` for a seamless panorama — the exact
 * body POST /v2/consumer/workflows accepts.
 *
 * Custom-node handling: a bare `nodepack` AIR is rejected at submit; the pack
 * must arrive as an image-specific INSTALL-LAYER AIR. Two forms:
 *  - no cached layer → 2-step: a `comfyNodepackSnapshot` step captures (or
 *    cache-hits) the layer, and the customComfy step `$ref`s its output. The
 *    orchestrator caches captured layers, so the extra step is cheap after the
 *    first run.
 *  - `layerAir` known (cached from a previous run) → single-step submit with
 *    the layer AIR inlined. Invalidate + fall back to 2-step on failure — the
 *    layer is image-specific and goes stale when the worker image rolls over.
 */
export function buildSeamlessTemplate(
  body: PanoBody,
  layerAir?: string,
): Record<string, unknown> {
  const graph = buildSeamlessGraph(body);

  // trace: 'binary' records the worker's ComfyUI /ws session to a streamable
  // blob (steps[].output.traceUrl) — the run UI tails it for real sampler
  // progress, live previews, and logs.
  const genStep = (resources: unknown[]) => ({
    $type: 'customComfy',
    name: GEN_STEP_NAME,
    timeout: '01:00:00',
    input: {
      resources,
      trace: 'binary',
      workflow: graph,
    },
  });

  if (layerAir) {
    return { steps: [genStep([layerAir, CHECKPOINT_AIR, LORA_AIR])] };
  }

  return {
    steps: [
      {
        $type: 'comfyNodepackSnapshot',
        name: SNAPSHOT_STEP_NAME,
        input: { nodepacks: [NODEPACK_AIR] },
      },
      genStep([
        { $ref: SNAPSHOT_STEP_NAME, path: 'output.results[0].layerAir' },
        CHECKPOINT_AIR,
        LORA_AIR,
      ]),
    ],
  };
}

// ---------------------------------------------------------------------------
// Orchestrator workflow document -> BlockWorkflowSnapshot mapping (what the
// platform host does server-side today for textToImage).
// ---------------------------------------------------------------------------

/** The kit's rich consumer-API doc type (jobs, queuePosition, usage, traceUrl). */
export type OrchestratorWorkflowDoc = OrchWorkflowDoc;

const STATUS_MAP: Record<string, BlockWorkflowSnapshot['status']> = {
  succeeded: 'succeeded',
  failed: 'failed',
  expired: 'expired',
  canceled: 'canceled',
  processing: 'processing',
};

export function mapWorkflowToSnapshot(doc: OrchestratorWorkflowDoc): BlockWorkflowSnapshot {
  const status = STATUS_MAP[doc.status ?? ''] ?? 'pending';
  const snapshot: BlockWorkflowSnapshot = {
    workflowId: doc.id ?? '',
    status,
  };
  const total = doc.cost?.total;
  if (typeof total === 'number') snapshot.cost = { total };
  const urls = (doc.steps ?? [])
    .flatMap((s) => s.output?.blobs ?? [])
    .map((b) => b.url)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (urls.length > 0) snapshot.imageUrls = urls;
  if (status === 'failed' || status === 'expired' || status === 'canceled') {
    snapshot.error = doc.transactions?.insufficientBuzz
      ? 'Insufficient Buzz for this generation.'
      : ((doc.steps ?? []).find((s) => s.metadata?.error)?.metadata?.error ??
        `Generation ${status}.`);
  }
  return snapshot;
}

/**
 * Pull the captured install-layer AIR out of a workflow doc's snapshot step, so
 * later generations can submit single-step. `undefined` when the doc has no
 * snapshot step (single-step submit) or the capture hasn't finished.
 */
export function extractLayerAir(doc: OrchestratorWorkflowDoc): string | undefined {
  const step = (doc.steps ?? []).find((s) => s.name === SNAPSHOT_STEP_NAME);
  const layerAir = step?.output?.results?.[0]?.layerAir;
  return typeof layerAir === 'string' && layerAir.length > 0 ? layerAir : undefined;
}
