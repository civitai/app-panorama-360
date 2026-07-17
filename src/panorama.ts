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

export type PanoMode = 'seamless' | 'zimage' | 'hosted';

/** Which generation recipe the server-owned translation runs. */
export type PanoEngine = 'sdxl' | 'zimage-turbo';

/** A picked SDXL checkpoint (from the host's checkpoint picker). */
export interface PanoCheckpoint {
  modelId: number;
  versionId: number;
}

export interface PanoBody {
  kind: 'pano360';
  /** The scene to wrap around the viewer (trigger words are added on translation). */
  prompt: string;
  /** Sampler seed; omit for random. */
  seed?: number;
  /** Preferred Buzz pool; omitted = host-chosen (Auto). */
  accountType?: BuzzAccountType;
  /** Recipe: 'sdxl' (conv-wrap seamless, default) or 'zimage-turbo' (fast, seam inpainted). */
  engine?: PanoEngine;
  /** SDXL checkpoint override (picker result); ignored by the zimage engine. */
  checkpoint?: PanoCheckpoint;
}

// Juggernaut XL Ragnarok — SDXL checkpoint already proven on Civitai's comfy workers.
export const CHECKPOINT_MODEL_ID = 133005;
export const CHECKPOINT_VERSION_ID = 1759168;
export const CHECKPOINT_AIR = `urn:air:sdxl:checkpoint:civitai:${CHECKPOINT_MODEL_ID}@${CHECKPOINT_VERSION_ID}`;
export const CHECKPOINT_DEFAULT_NAME = 'Juggernaut XL · Ragnarok';

export function sdxlCheckpointAir(checkpoint: PanoCheckpoint): string {
  return `urn:air:sdxl:checkpoint:civitai:${checkpoint.modelId}@${checkpoint.versionId}`;
}

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

// ---------------------------------------------------------------------------
// Z-IMAGE TURBO engine — the fast recipe. Z-Image is a DiT (no UNet convs), so
// the SeamlessTile circular-padding trick can't apply; instead the graph
// renders normally and then HEALS the seam: roll the image 50% so the wrap
// edge lands in the center, inpaint a feathered band across it (partial
// denoise, same model), and roll back. Few-step turbo sampling (cfg 1) makes
// the whole thing land around 10-25 Buzz.
//
// Model set mirrors the spine workers' own Z-Image graph builders
// (UNETLoader + CLIPLoader[lumina2] + Flux VAE + ModelSamplingAuraFlow shift 3).
// ---------------------------------------------------------------------------

export const ZIMAGE_DIFFUSION_AIR =
  'urn:air:zimageturbo:diffusion_model:huggingface:Comfy-Org/z_image_turbo@main/split_files/diffusion_models/z_image_turbo_bf16.safetensors';
export const ZIMAGE_CLIP_AIR =
  'urn:air:qwen:clip:huggingface:Comfy-Org/z_image_turbo@main/split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors';
export const ZIMAGE_VAE_AIR =
  'urn:air:flux1:vae:huggingface:black-forest-labs/FLUX.1-dev@main/ae.safetensors';
// 360Redmond's Z-Image Turbo version. Trained words: "360 View", "360".
// Ecosystem `zimageturbo` (the version's canonical AIR per the civitai API) —
// `zimage:lora` fails resource resolution on the workers.
export const ZIMAGE_LORA_VERSION_ID = 2702227;
export const ZIMAGE_LORA_AIR = `urn:air:zimageturbo:lora:civitai:${LORA_MODEL_ID}@${ZIMAGE_LORA_VERSION_ID}`;
export const ZIMAGE_LORA_STRENGTH = 1.0;
export const ZIMAGE_TRIGGER_WORDS = '360 view, 360, ';

export const ZIMAGE_STEPS = 8;
export const ZIMAGE_CFG = 1;
export const ZIMAGE_SHIFT = 3.0;
export const ZIMAGE_SAMPLER = 'euler';
export const ZIMAGE_SCHEDULER = 'simple';

/** Seam-heal tunables: band width/feather in px, inpaint denoise fraction.
 * E2E-tuned: denoise 0.5 left the seam line partially intact (wrap ratio 4.2)
 * and a visible tonal step at the band edge — 0.7 + a wider feather heals it. */
export const SEAM_BAND_PX = 320;
export const SEAM_FEATHER_PX = 128;
export const SEAM_DENOISE = 0.7;
export const SEAM_STEPS = 8;

export const ZIMAGE_ESTIMATE_BUZZ = 20;

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

export interface PanoBodyOptions {
  engine?: PanoEngine;
  checkpoint?: PanoCheckpoint;
}

export function buildPanoBody(
  prompt: string,
  seed?: number,
  accountType?: BuzzAccountType,
  options: PanoBodyOptions = {},
): PanoBody {
  const body: PanoBody = { kind: 'pano360', prompt: clampPrompt(prompt) };
  if (seed !== undefined) body.seed = seed;
  if (accountType) body.accountType = accountType;
  if (options.engine && options.engine !== 'sdxl') body.engine = options.engine;
  if (options.checkpoint && (options.engine ?? 'sdxl') === 'sdxl') {
    body.checkpoint = options.checkpoint;
  }
  return body;
}

/** The full positive prompt: LoRA trigger words + scene + quality tail. */
export function positivePrompt(scene: string): string {
  return TRIGGER_WORDS + clampPrompt(scene) + PROMPT_SUFFIX;
}

/** Z-Image variant — its LoRA version uses differently-ordered trigger words. */
export function zimagePositivePrompt(scene: string): string {
  return ZIMAGE_TRIGGER_WORDS + clampPrompt(scene) + PROMPT_SUFFIX;
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
  checkpoint?: PanoCheckpoint,
): WorkflowBody {
  const body: WorkflowBody = {
    kind: 'textToImage',
    modelId: checkpoint?.modelId ?? CHECKPOINT_MODEL_ID,
    modelVersionId: checkpoint?.versionId ?? CHECKPOINT_VERSION_ID,
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
  const checkpointAir = body.checkpoint ? sdxlCheckpointAir(body.checkpoint) : CHECKPOINT_AIR;
  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: checkpointAir },
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
  const checkpointAir = body.checkpoint ? sdxlCheckpointAir(body.checkpoint) : CHECKPOINT_AIR;

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
    return { steps: [genStep([layerAir, checkpointAir, LORA_AIR])] };
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
        checkpointAir,
        LORA_AIR,
      ]),
    ],
  };
}

// ---------------------------------------------------------------------------
// Z-IMAGE TURBO translation — render, then heal the seam.
//
// txt2img mirrors the spine workers' own Z-Image graph (split loaders, lumina2
// text encoder, Flux VAE, AuraFlow shift 3, turbo euler/simple cfg 1). The
// seam heal: ComfyUI has no image "roll" node, so the 50% roll is 2x ImageCrop
// + ImageStitch with the halves swapped (an involution — applying it again
// rolls back). The wrap edge then sits at x=1024, where a feathered band mask
// + SetLatentNoiseMask + partial-denoise KSampler repaints it in context.
// ---------------------------------------------------------------------------

export function buildZimageSeamlessGraph(body: PanoBody): ComfyGraph {
  const seed = body.seed ?? Math.floor(Math.random() * 2_147_483_647);
  const half = PANO_WIDTH / 2;

  const rollNodes = (id: number, image: [string, number]): ComfyGraph => ({
    [`${id}`]: {
      class_type: 'ImageCrop',
      inputs: { image, width: half, height: PANO_HEIGHT, x: 0, y: 0 },
    },
    [`${id + 1}`]: {
      class_type: 'ImageCrop',
      inputs: { image, width: half, height: PANO_HEIGHT, x: half, y: 0 },
    },
    [`${id + 2}`]: {
      class_type: 'ImageStitch',
      inputs: {
        image1: [`${id + 1}`, 0],
        image2: [`${id}`, 0],
        direction: 'right',
        match_image_size: true,
        spacing_width: 0,
        spacing_color: 'white',
      },
    },
  });

  return {
    // txt2img
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: ZIMAGE_DIFFUSION_AIR, weight_dtype: 'default' },
    },
    '2': {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['1', 0], lora_name: ZIMAGE_LORA_AIR, strength_model: ZIMAGE_LORA_STRENGTH },
    },
    '3': {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { model: ['2', 0], shift: ZIMAGE_SHIFT },
    },
    '4': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: ZIMAGE_CLIP_AIR, type: 'lumina2', device: 'default' },
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 0], text: zimagePositivePrompt(body.prompt) },
    },
    // Wired but inert at cfg 1 (turbo runs without guidance).
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 0], text: '' },
    },
    '7': {
      class_type: 'VAELoader',
      inputs: { vae_name: ZIMAGE_VAE_AIR },
    },
    '8': {
      class_type: 'EmptySD3LatentImage',
      inputs: { width: PANO_WIDTH, height: PANO_HEIGHT, batch_size: 1 },
    },
    '9': {
      class_type: 'KSampler',
      inputs: {
        model: ['3', 0],
        positive: ['5', 0],
        negative: ['6', 0],
        latent_image: ['8', 0],
        seed,
        steps: ZIMAGE_STEPS,
        cfg: ZIMAGE_CFG,
        sampler_name: ZIMAGE_SAMPLER,
        scheduler: ZIMAGE_SCHEDULER,
        denoise: 1.0,
      },
    },
    '10': {
      class_type: 'VAEDecode',
      inputs: { samples: ['9', 0], vae: ['7', 0] },
    },
    // roll 50% — wrap edge to center (11: left, 12: right, 13: [R|L])
    ...rollNodes(11, ['10', 0]),
    // feathered band mask over the centered seam
    '14': {
      class_type: 'SolidMask',
      inputs: { value: 0, width: PANO_WIDTH, height: PANO_HEIGHT },
    },
    '15': {
      class_type: 'SolidMask',
      inputs: { value: 1, width: SEAM_BAND_PX, height: PANO_HEIGHT },
    },
    '16': {
      class_type: 'MaskComposite',
      inputs: {
        destination: ['14', 0],
        source: ['15', 0],
        x: (PANO_WIDTH - SEAM_BAND_PX) / 2,
        y: 0,
        operation: 'add',
      },
    },
    '17': {
      class_type: 'FeatherMask',
      inputs: { mask: ['16', 0], left: SEAM_FEATHER_PX, top: 0, right: SEAM_FEATHER_PX, bottom: 0 },
    },
    // inpaint the band in context (partial denoise, same model)
    '18': {
      class_type: 'VAEEncode',
      inputs: { pixels: ['13', 0], vae: ['7', 0] },
    },
    '19': {
      class_type: 'SetLatentNoiseMask',
      inputs: { samples: ['18', 0], mask: ['17', 0] },
    },
    '20': {
      class_type: 'KSampler',
      inputs: {
        model: ['3', 0],
        positive: ['5', 0],
        negative: ['6', 0],
        latent_image: ['19', 0],
        seed: seed + 1,
        steps: SEAM_STEPS,
        cfg: ZIMAGE_CFG,
        sampler_name: ZIMAGE_SAMPLER,
        scheduler: ZIMAGE_SCHEDULER,
        denoise: SEAM_DENOISE,
      },
    },
    '21': {
      class_type: 'VAEDecode',
      inputs: { samples: ['20', 0], vae: ['7', 0] },
    },
    // roll back (22: left, 23: right, 24: [R|L] — the involution restores order)
    ...rollNodes(22, ['21', 0]),
    '25': {
      class_type: 'SaveImage',
      inputs: { images: ['24', 0], filename_prefix: 'panorama' },
    },
  };
}

/**
 * The Z-Image Turbo orchestrator template: ONE customComfy step — the recipe
 * uses only stock ComfyUI nodes, so there is no nodepack snapshot step and no
 * install-layer cache to manage.
 */
export function buildZimageSeamlessTemplate(body: PanoBody): Record<string, unknown> {
  return {
    steps: [
      {
        $type: 'customComfy',
        name: GEN_STEP_NAME,
        timeout: '01:00:00',
        input: {
          resources: [ZIMAGE_DIFFUSION_AIR, ZIMAGE_CLIP_AIR, ZIMAGE_VAE_AIR, ZIMAGE_LORA_AIR],
          trace: 'binary',
          workflow: buildZimageSeamlessGraph(body),
        },
      },
    ],
  };
}

export const ZIMAGE_NODE_LABELS: Record<string, string> = {
  '1': 'Loading Z-Image Turbo',
  '2': 'Applying 360 LoRA',
  '3': 'Tuning the sampler',
  '4': 'Loading text encoder',
  '5': 'Encoding prompt',
  '7': 'Loading VAE',
  '8': 'Preparing canvas',
  '9': 'Sampling',
  '10': 'Decoding image',
  '11': 'Centering the seam',
  '12': 'Centering the seam',
  '13': 'Centering the seam',
  '14': 'Masking the seam',
  '15': 'Masking the seam',
  '16': 'Masking the seam',
  '17': 'Masking the seam',
  '18': 'Encoding for seam heal',
  '19': 'Masking the seam',
  '20': 'Healing the seam',
  '21': 'Decoding healed image',
  '22': 'Restoring the wrap',
  '23': 'Restoring the wrap',
  '24': 'Restoring the wrap',
  '25': 'Saving panorama',
};

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
