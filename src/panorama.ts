// Pure Panorama Studio logic — bodies, Comfy graph translations, doc mapping.
// No DOM; unit-tested in node (panorama.test.ts).

import type {
  BlockWorkflowSnapshot,
  BuzzAccountType,
  WorkflowBodyCustomComfy,
  WorkflowBodyTextToImage,
} from '@civitai/app-sdk/blocks';
import type { OrchWorkflowDoc } from '@civitai/comfy-run-kit';

// The platform's block bridge accepts only `kind: 'textToImage'` today. The
// `pano360` kind is this app's PROPOSED server-owned contract (bounded knobs,
// never a raw graph); orch-host.ts stands in for the missing platform side.

// v1 user-facing modes: the three DiT seamless engines ride the bounded
// customComfy recipe, and `hosted` is the plain SDXL textToImage path (seam
// visible, checkpoint-pickable). The old SDXL conv-wrap `seamless` mode is
// deferred to v2 (it needs nodepack baking) — it is NOT offered in v1.
export type PanoMode = 'zimage' | 'flux2' | 'qwen' | 'hosted';

/**
 * Which generation recipe the server-owned translation runs. `sdxl` is the
 * legacy conv-wrap engine — retained only for the `dev:orch` local fallback +
 * the legacy `pano360` body; no v1 user-facing mode maps to it.
 */
export const PANO_ENGINES = ['sdxl', 'zimage-turbo', 'flux2-klein', 'qwen-image'] as const;
export type PanoEngine = (typeof PANO_ENGINES)[number];

/**
 * Runtime guard for `PanoEngine`. Needed because the SDK's `customComfy` arm
 * types `params.engine` as the open `string` — when translating an inbound
 * recipe body back to a `PanoBody` (dev:orch fallback) we only adopt an engine
 * this app actually knows, and drop anything unrecognized to the recipe default.
 */
export const isPanoEngine = (v: unknown): v is PanoEngine =>
  typeof v === 'string' && (PANO_ENGINES as readonly string[]).includes(v);

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
  /** Recipe: 'sdxl' (conv-wrap seamless, default) or a DiT engine (seam inpainted). */
  engine?: PanoEngine;
  /** SDXL checkpoint override (picker result); ignored by the DiT engines. */
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

// 360Redmond, deliberately its SDXL version: the seamless-wrap trick patches
// UNet conv layers, which the DiT versions of this LoRA don't have.
export const LORA_MODEL_ID = 118025;
export const LORA_VERSION_ID = 143197;
export const LORA_AIR = `urn:air:sdxl:lora:civitai:${LORA_MODEL_ID}@${LORA_VERSION_ID}`;
export const LORA_STRENGTH = 0.6;
export const LORA_CLIP_STRENGTH = 1.0;

export const NODEPACK_AIR =
  'urn:air:comfy:nodepack:comfyregistry:spinagon/comfyui-seamless-tiling@1.0.0';

export const TRIGGER_WORDS = '360, 360view, ';
export const PROMPT_SUFFIX = ', ultra detailed, masterpiece, best quality';
export const NEGATIVE_PROMPT =
  'ugly, blurry, low quality, watermark, jpeg artifacts, deformed, text, border, frame';

// 2048 is also the block bridge's DIM_MAX, so hosted mode uses the same canvas.
export const PANO_WIDTH = 2048;
export const PANO_HEIGHT = 1024;
export const PANO_STEPS = 30;
export const PANO_CFG = 7;
export const PANO_SAMPLER = 'dpmpp_2m';
export const PANO_SCHEDULER = 'karras';
/** The hosted (textToImage) body spells the sampler the platform way. */
export const HOSTED_SAMPLER = 'DPM++ 2M Karras';

export const PROMPT_MAX = 1500;

/** customComfy bills post-paid (1 Buzz per GPU-second) — there is no exact pre-price. */
export const PANORAMA_ESTIMATE_BUZZ = 60;

// Z-Image Turbo — model set mirrors the spine workers' own Z-Image builders.
export const ZIMAGE_DIFFUSION_AIR =
  'urn:air:zimageturbo:diffusion_model:huggingface:Comfy-Org/z_image_turbo@main/split_files/diffusion_models/z_image_turbo_bf16.safetensors';
export const ZIMAGE_CLIP_AIR =
  'urn:air:qwen:clip:huggingface:Comfy-Org/z_image_turbo@main/split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors';
export const ZIMAGE_VAE_AIR =
  'urn:air:flux1:vae:huggingface:black-forest-labs/FLUX.1-dev@main/ae.safetensors';
// Ecosystem must be `zimageturbo` (the version's canonical AIR per the civitai
// API) — `zimage:lora` fails resource resolution on the workers.
export const ZIMAGE_LORA_VERSION_ID = 2702227;
export const ZIMAGE_LORA_AIR = `urn:air:zimageturbo:lora:civitai:${LORA_MODEL_ID}@${ZIMAGE_LORA_VERSION_ID}`;
export const ZIMAGE_LORA_STRENGTH = 1.0;
export const ZIMAGE_TRIGGER_WORDS = '360 view, 360, ';

export const ZIMAGE_STEPS = 8;
export const ZIMAGE_CFG = 1;
export const ZIMAGE_SHIFT = 3.0;
export const ZIMAGE_SAMPLER = 'euler';
export const ZIMAGE_SCHEDULER = 'simple';

// Seam-heal tunables. Denoise below 0.7 leaves the seam line partially intact
// and a tonal step at the band edge; the wide feather blends the repaint in.
export const SEAM_BAND_PX = 320;
export const SEAM_FEATHER_PX = 128;
export const SEAM_DENOISE = 0.7;
export const SEAM_STEPS = 8;

export const ZIMAGE_ESTIMATE_BUZZ = 20;

// Qwen Image. The GGUF is the exact file prod textToImage resolves for Qwen
// (warm worker caches) and its 2512 base matches this LoRA variant.
export const QWEN_DIFFUSION_AIR =
  'urn:air:qwen:diffusion_model:huggingface:unsloth/Qwen-Image-2512-GGUF@main/qwen-image-2512-Q5_K_M.gguf';
export const QWEN_CLIP_AIR =
  'urn:air:qwen:clip:huggingface:Comfy-Org/Qwen-Image_ComfyUI@main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors';
export const QWEN_VAE_AIR =
  'urn:air:qwen:vae:huggingface:Comfy-Org/Qwen-Image_ComfyUI@main/split_files/vae/qwen_image_vae.safetensors';
export const QWEN_LORA_VERSION_ID = 2702222;
export const QWEN_LORA_AIR = `urn:air:qwen:lora:civitai:${LORA_MODEL_ID}@${QWEN_LORA_VERSION_ID}`;
export const QWEN_TRIGGER_WORDS = '360 VIEW, 360, ';

export const QWEN_STEPS = 20;
export const QWEN_CFG = 2.5;
export const QWEN_SHIFT = 3.1;

export const QWEN_ESTIMATE_BUZZ = 150;

// Flux2 Klein 9B — prod's ComfyUI variant ("9b-kv" in Flux2KleinImageGenInput):
// all-safetensors model set, sampled with the custom scheduler/guider stack.
export const FLUX2_DIFFUSION_AIR =
  'urn:air:flux2:diffusion_model:huggingface:black-forest-labs/FLUX.2-klein-9b-kv-fp8@main/flux-2-klein-9b-kv-fp8.safetensors';
export const FLUX2_CLIP_AIR =
  'urn:air:flux2:text_encoders:huggingface:Comfy-Org/vae-text-encorder-for-flux-klein-9b@main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors';
export const FLUX2_VAE_AIR =
  'urn:air:flux2:vae:huggingface:Comfy-Org/vae-text-encorder-for-flux-klein-9b@main/split_files/vae/flux2-vae.safetensors';
export const FLUX2_LORA_VERSION_ID = 2702214;
export const FLUX2_LORA_AIR = `urn:air:flux2:lora:civitai:${LORA_MODEL_ID}@${FLUX2_LORA_VERSION_ID}`;
export const FLUX2_LORA_STRENGTH = 1.0;
export const FLUX2_TRIGGER_WORDS = '360 View, 360, ';

// Klein is step-distilled but NOT guidance-distilled — cfg 5 is real guidance,
// so the negative prompt is active.
export const FLUX2_STEPS = 8;
export const FLUX2_CFG = 5;

export const FLUX2_ESTIMATE_BUZZ = 45;

export interface ScenePreset {
  id: string;
  label: string;
  prompt: string;
}

// Open spaces with a clear horizon read best — equirectangular projection
// stretches the poles.
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

// ── Real platform bridge: the bounded `customComfy` block-workflow ──────────
// The platform now owns a bounded `kind:'customComfy'` recipe (civitai #3228):
// the block sends only knobs, the SERVER owns the graph (a port of this app's
// own DiT/seamless templates below). This is the body the RunController submits
// on the REAL bridge — `pano360` + the client-side graph builders now serve
// ONLY the optional `dev:orch` local fallback (orch-host.ts).
//
// The SDK's `WorkflowBody` is now a discriminated union whose `customComfy` arm
// (`WorkflowBodyCustomComfy`) IS the server's recipe body — shipped in
// `@civitai/app-sdk@0.26` / `@civitai/blocks-react@0.33` (civitai-app-starters
// PR #171). We build/guard/translate that SDK type directly; the app's engine
// enum (`RecipeEngine`) is narrower than the SDK arm's `engine?: string`, which
// is assignable.

/** The server-owned recipe key this app's block workflows target. */
export const CUSTOM_COMFY_RECIPE = 'seamless-pano-360' as const;

/**
 * The recipe's bounded engine enum — exactly this app's DiT engines
 * (`DitEngine`). v1 is DiT-only: every customComfy body carries one of these
 * (the SDXL conv-wrap path is deferred to v2). See `MODE_ENGINE`.
 */
export type RecipeEngine = DitEngine;

export interface CustomComfyParams {
  prompt: string;
  /** Sampler seed; omit for random. `null` is treated as omitted. */
  seed?: number | null;
  /** The DiT seamless engine this recipe runs (v1 always sets one). */
  engine?: RecipeEngine;
  /** Preferred Buzz pool; omitted = host-chosen (Auto). */
  accountType?: BuzzAccountType;
}

/**
 * The real-bridge body for the DiT seamless modes. `engine` is the recipe enum
 * — one of `zimage-turbo`/`flux2-klein`/`qwen-image`, always set (v1 is
 * DiT-only, so no engine-omitted / SDXL-conv-wrap body is ever built here). The
 * bounded recipe owns the checkpoint server-side, so (unlike the old `pano360`
 * body) there is no checkpoint override.
 */
export function buildCustomComfyBody(
  prompt: string,
  seed: number | undefined,
  accountType: BuzzAccountType | undefined,
  engine: DitEngine,
): WorkflowBodyCustomComfy {
  const params: CustomComfyParams = { prompt: clampPrompt(prompt), engine };
  if (seed !== undefined) params.seed = seed;
  if (accountType) params.accountType = accountType;
  return { kind: 'customComfy', recipe: CUSTOM_COMFY_RECIPE, params };
}

export const isCustomComfyBody = (body: unknown): body is WorkflowBodyCustomComfy =>
  typeof body === 'object' &&
  body !== null &&
  (body as { kind?: unknown }).kind === 'customComfy' &&
  (body as { recipe?: unknown }).recipe === CUSTOM_COMFY_RECIPE;

/**
 * Translate a real-bridge `customComfy` body back into the internal `PanoBody`
 * the dev:orch fallback's graph/template builders consume. Omitted engine →
 * `sdxl` (the recipe default). The bounded recipe carries no checkpoint, so
 * dev:orch uses the default SDXL checkpoint — matching the server-owned graph.
 */
export function customComfyToPanoBody(body: WorkflowBodyCustomComfy): PanoBody {
  const pano: PanoBody = { kind: 'pano360', prompt: clampPrompt(body.params.prompt) };
  if (typeof body.params.seed === 'number') pano.seed = body.params.seed;
  if (body.params.accountType) pano.accountType = body.params.accountType;
  if (isPanoEngine(body.params.engine)) pano.engine = body.params.engine;
  return pano;
}

export function positivePrompt(scene: string): string {
  return TRIGGER_WORDS + clampPrompt(scene) + PROMPT_SUFFIX;
}

/** Each DiT LoRA variant publishes differently-cased/ordered trigger words. */
export function ditPositivePrompt(triggerWords: string, scene: string): string {
  return triggerWords + clampPrompt(scene) + PROMPT_SUFFIX;
}

export function zimagePositivePrompt(scene: string): string {
  return ditPositivePrompt(ZIMAGE_TRIGGER_WORDS, scene);
}

/** The plain textToImage body the real bridge accepts today (visible seam). */
export function buildHostedBody(
  prompt: string,
  seed?: number,
  accountType?: BuzzAccountType,
  checkpoint?: PanoCheckpoint,
): WorkflowBodyTextToImage {
  const body: WorkflowBodyTextToImage = {
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

/** A ComfyUI /prompt graph: node-id keyed, class_type + inputs, link refs ['id', slot]. */
export type ComfyGraph = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;

// The wrap trick: SeamlessTile flips every UNet conv's x-axis padding to
// `circular`, so the sampler paints edges that continue into each other;
// the VAE gets the same patch so decoding doesn't reintroduce an edge.
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
    // "Modify in place": this pack's copy branch uses copy.deepcopy, which
    // crashes on modern ComfyUI model/VAE objects. In-place is safe in a
    // one-shot job container.
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
    // NOT CircularVAEDecode — it always deep-copies the VAE (same crash, no
    // in-place option). MakeCircularVAE + stock VAEDecode is the same patch.
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

/** Shown by the run-status element as the trace's `executing` events walk the graph. */
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
 * A bare `nodepack` AIR is rejected at submit; the pack must arrive as an
 * image-specific install-layer AIR. Without a cached `layerAir` this submits
 * 2-step (comfyNodepackSnapshot + $ref); with one, single-step. Cached layers
 * go stale when the worker image rolls over — invalidate and fall back.
 */
export function buildSeamlessTemplate(
  body: PanoBody,
  layerAir?: string,
): Record<string, unknown> {
  const graph = buildSeamlessGraph(body);
  const checkpointAir = body.checkpoint ? sdxlCheckpointAir(body.checkpoint) : CHECKPOINT_AIR;

  // trace: 'binary' records the worker's ComfyUI /ws session to a streamable
  // blob — the run UI tails it for sampler progress, previews, and logs.
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

/** The subset of the bridge textToImage body the Standard translation reads. */
export interface HostedBodyLike {
  kind: 'textToImage';
  modelId: number;
  modelVersionId: number;
  additionalResources?: Array<{ modelVersionId: number; strength?: number }>;
  params: {
    prompt: string;
    negativePrompt?: string;
    width: number;
    height: number;
    steps: number;
    cfgScale: number;
    seed?: number;
  };
}

export const isHostedBody = (body: unknown): body is HostedBodyLike =>
  typeof body === 'object' && body !== null && (body as { kind?: unknown }).kind === 'textToImage';

/**
 * Runs a hosted-mode body as a real plain generation in dev:orch, so Standard
 * never returns a mock image next to real spend. No wrap patch — Standard's
 * visible seam is the honest behavior.
 */
export function buildStandardTemplate(body: HostedBodyLike): Record<string, unknown> {
  const seed = body.params.seed ?? Math.floor(Math.random() * 2_147_483_647);
  const checkpointAir = sdxlCheckpointAir({
    modelId: body.modelId,
    versionId: body.modelVersionId,
  });
  // The bridge wire format carries just the versionId; the dev harness can map
  // only its OWN LoRA back to an AIR.
  const lora = body.additionalResources?.find((r) => r.modelVersionId === LORA_VERSION_ID);

  const modelSource: [string, number] = lora ? ['2', 0] : ['1', 0];
  const clipSource: [string, number] = lora ? ['2', 1] : ['1', 1];
  const graph: ComfyGraph = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpointAir } },
    ...(lora && {
      '2': {
        class_type: 'LoraLoader',
        inputs: {
          model: ['1', 0],
          clip: ['1', 1],
          lora_name: LORA_AIR,
          strength_model: lora.strength ?? LORA_STRENGTH,
          strength_clip: LORA_CLIP_STRENGTH,
        },
      },
    }),
    '4': { class_type: 'CLIPTextEncode', inputs: { clip: clipSource, text: body.params.prompt } },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: clipSource, text: body.params.negativePrompt ?? '' },
    },
    '6': {
      class_type: 'EmptyLatentImage',
      inputs: { width: body.params.width, height: body.params.height, batch_size: 1 },
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: modelSource,
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        seed,
        steps: body.params.steps,
        cfg: body.params.cfgScale,
        sampler_name: PANO_SAMPLER,
        scheduler: PANO_SCHEDULER,
        denoise: 1.0,
      },
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
    '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'panorama' } },
  };

  return {
    steps: [
      {
        $type: 'customComfy',
        name: GEN_STEP_NAME,
        timeout: '01:00:00',
        input: {
          resources: [checkpointAir, ...(lora ? [LORA_AIR] : [])],
          trace: 'binary',
          workflow: graph,
        },
      },
    ],
  };
}

/** Reuses the seamless graph's node numbering minus the wrap nodes. */
export const STANDARD_NODE_LABELS: Record<string, string> = {
  '1': 'Loading checkpoint',
  '2': 'Applying 360 LoRA',
  '4': 'Encoding prompt',
  '5': 'Encoding negative prompt',
  '6': 'Preparing canvas',
  '7': 'Sampling',
  '9': 'Decoding image',
  '10': 'Saving panorama',
};

// DiT models have no UNet convs, so the wrap trick can't apply. Instead:
// render, roll the image 50% so the wrap edge lands in the center, inpaint a
// feathered band across it (partial denoise, same model), roll back. Z-Image
// and Qwen share one KSampler-shaped graph; Klein needs the fleet's custom
// sampler stack (buildFlux2SeamlessGraph).

/** Everything that differs between the KSampler-shaped DiT engines. */
export interface DitEngineSpec {
  diffusionAir: string;
  /** The whole diffusion-loader node — engines differ in loader class too. */
  loader: { class_type: string; inputs: Record<string, unknown> };
  clipAir: string;
  clipType: string;
  vaeAir: string;
  loraAir: string;
  loraStrength: number;
  triggerWords: string;
  shift: number;
  steps: number;
  cfg: number;
  /** '' when cfg is 1 (guidance off — the encode is wired but inert). */
  negativePrompt: string;
  modelLabel: string;
}

export const ZIMAGE_SPEC: DitEngineSpec = {
  diffusionAir: ZIMAGE_DIFFUSION_AIR,
  loader: {
    class_type: 'UNETLoader',
    inputs: { unet_name: ZIMAGE_DIFFUSION_AIR, weight_dtype: 'default' },
  },
  clipAir: ZIMAGE_CLIP_AIR,
  clipType: 'lumina2',
  vaeAir: ZIMAGE_VAE_AIR,
  loraAir: ZIMAGE_LORA_AIR,
  loraStrength: ZIMAGE_LORA_STRENGTH,
  triggerWords: ZIMAGE_TRIGGER_WORDS,
  shift: ZIMAGE_SHIFT,
  steps: ZIMAGE_STEPS,
  cfg: ZIMAGE_CFG,
  negativePrompt: '',
  modelLabel: 'Z-Image Turbo',
};

export const QWEN_SPEC: DitEngineSpec = {
  diffusionAir: QWEN_DIFFUSION_AIR,
  // The fleet launches ComfyUI with --use-sage-attention, and SageAttention
  // silently corrupts the attention mask Qwen passes on every block — runs
  // "succeed" but output pure noise. GGUFLoaderKJ is the only fleet-baked
  // node exposing attention_override; sdpa forces pytorch attention here.
  loader: {
    class_type: 'GGUFLoaderKJ',
    inputs: {
      model_name: QWEN_DIFFUSION_AIR,
      extra_model_name: 'none',
      dequant_dtype: 'default',
      patch_dtype: 'default',
      patch_on_device: false,
      enable_fp16_accumulation: false,
      attention_override: 'sdpa',
    },
  },
  clipAir: QWEN_CLIP_AIR,
  clipType: 'qwen_image',
  vaeAir: QWEN_VAE_AIR,
  loraAir: QWEN_LORA_AIR,
  loraStrength: 1.0,
  triggerWords: QWEN_TRIGGER_WORDS,
  shift: QWEN_SHIFT,
  steps: QWEN_STEPS,
  cfg: QWEN_CFG,
  negativePrompt: NEGATIVE_PROMPT,
  modelLabel: 'Qwen Image',
};

const HALF_W = PANO_WIDTH / 2;

/**
 * 50% horizontal roll: id: left crop, id+1: right crop, id+2: [R|L] stitch.
 * ComfyUI has no roll node; crop+stitch is an involution, so applying it
 * again rolls back.
 */
function rollNodes(id: number, image: [string, number]): ComfyGraph {
  return {
    [`${id}`]: {
      class_type: 'ImageCrop',
      inputs: { image, width: HALF_W, height: PANO_HEIGHT, x: 0, y: 0 },
    },
    [`${id + 1}`]: {
      class_type: 'ImageCrop',
      inputs: { image, width: HALF_W, height: PANO_HEIGHT, x: HALF_W, y: 0 },
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
  };
}

/** Feathered band mask over the centered seam: ids id..id+3, output at id+3. */
function bandMaskNodes(id: number): ComfyGraph {
  return {
    [`${id}`]: {
      class_type: 'SolidMask',
      inputs: { value: 0, width: PANO_WIDTH, height: PANO_HEIGHT },
    },
    [`${id + 1}`]: {
      class_type: 'SolidMask',
      inputs: { value: 1, width: SEAM_BAND_PX, height: PANO_HEIGHT },
    },
    [`${id + 2}`]: {
      class_type: 'MaskComposite',
      inputs: {
        destination: [`${id}`, 0],
        source: [`${id + 1}`, 0],
        x: (PANO_WIDTH - SEAM_BAND_PX) / 2,
        y: 0,
        operation: 'add',
      },
    },
    [`${id + 3}`]: {
      class_type: 'FeatherMask',
      inputs: {
        mask: [`${id + 2}`, 0],
        left: SEAM_FEATHER_PX,
        top: 0,
        right: SEAM_FEATHER_PX,
        bottom: 0,
      },
    },
  };
}

export function buildDitSeamlessGraph(spec: DitEngineSpec, body: PanoBody): ComfyGraph {
  const seed = body.seed ?? Math.floor(Math.random() * 2_147_483_647);

  return {
    '1': spec.loader,
    '2': {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['1', 0], lora_name: spec.loraAir, strength_model: spec.loraStrength },
    },
    '3': {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { model: ['2', 0], shift: spec.shift },
    },
    '4': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: spec.clipAir, type: spec.clipType, device: 'default' },
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 0], text: ditPositivePrompt(spec.triggerWords, body.prompt) },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 0], text: spec.negativePrompt },
    },
    '7': {
      class_type: 'VAELoader',
      inputs: { vae_name: spec.vaeAir },
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
        steps: spec.steps,
        cfg: spec.cfg,
        sampler_name: ZIMAGE_SAMPLER,
        scheduler: ZIMAGE_SCHEDULER,
        denoise: 1.0,
      },
    },
    '10': {
      class_type: 'VAEDecode',
      inputs: { samples: ['9', 0], vae: ['7', 0] },
    },
    ...rollNodes(11, ['10', 0]),
    ...bandMaskNodes(14),
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
        cfg: spec.cfg,
        sampler_name: ZIMAGE_SAMPLER,
        scheduler: ZIMAGE_SCHEDULER,
        denoise: SEAM_DENOISE,
      },
    },
    '21': {
      class_type: 'VAEDecode',
      inputs: { samples: ['20', 0], vae: ['7', 0] },
    },
    ...rollNodes(22, ['21', 0]),
    '25': {
      class_type: 'SaveImage',
      inputs: { images: ['24', 0], filename_prefix: 'panorama' },
    },
  };
}

export function buildZimageSeamlessGraph(body: PanoBody): ComfyGraph {
  return buildDitSeamlessGraph(ZIMAGE_SPEC, body);
}

export function buildQwenSeamlessGraph(body: PanoBody): ComfyGraph {
  return buildDitSeamlessGraph(QWEN_SPEC, body);
}

/**
 * Klein via the fleet's sampler stack. The seam pass gets its partial denoise
 * from SplitSigmasDenoise's low_sigmas (output 1): SamplerCustomAdvanced
 * scales its noise to the first sigma given, exactly like KSampler denoise<1.
 */
export function buildFlux2SeamlessGraph(body: PanoBody): ComfyGraph {
  const seed = body.seed ?? Math.floor(Math.random() * 2_147_483_647);

  return {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: FLUX2_DIFFUSION_AIR, weight_dtype: 'default' },
    },
    '2': {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['1', 0], lora_name: FLUX2_LORA_AIR, strength_model: FLUX2_LORA_STRENGTH },
    },
    '3': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: FLUX2_CLIP_AIR, type: 'flux2', device: 'default' },
    },
    '4': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['3', 0], text: ditPositivePrompt(FLUX2_TRIGGER_WORDS, body.prompt) },
    },
    '5': {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['3', 0], text: NEGATIVE_PROMPT },
    },
    '6': {
      class_type: 'VAELoader',
      inputs: { vae_name: FLUX2_VAE_AIR },
    },
    '7': {
      class_type: 'EmptyFlux2LatentImage',
      inputs: { width: PANO_WIDTH, height: PANO_HEIGHT, batch_size: 1 },
    },
    '8': {
      class_type: 'Flux2Scheduler',
      inputs: { steps: FLUX2_STEPS, width: PANO_WIDTH, height: PANO_HEIGHT },
    },
    '9': {
      class_type: 'CFGGuider',
      inputs: { model: ['2', 0], positive: ['4', 0], negative: ['5', 0], cfg: FLUX2_CFG },
    },
    '10': {
      class_type: 'RandomNoise',
      inputs: { noise_seed: seed },
    },
    '11': {
      class_type: 'KSamplerSelect',
      inputs: { sampler_name: ZIMAGE_SAMPLER },
    },
    '12': {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['10', 0],
        guider: ['9', 0],
        sampler: ['11', 0],
        sigmas: ['8', 0],
        latent_image: ['7', 0],
      },
    },
    '13': {
      class_type: 'VAEDecode',
      inputs: { samples: ['12', 0], vae: ['6', 0] },
    },
    ...rollNodes(14, ['13', 0]),
    ...bandMaskNodes(17),
    '21': {
      class_type: 'VAEEncode',
      inputs: { pixels: ['16', 0], vae: ['6', 0] },
    },
    '22': {
      class_type: 'SetLatentNoiseMask',
      inputs: { samples: ['21', 0], mask: ['20', 0] },
    },
    '23': {
      class_type: 'Flux2Scheduler',
      inputs: { steps: SEAM_STEPS, width: PANO_WIDTH, height: PANO_HEIGHT },
    },
    '24': {
      class_type: 'SplitSigmasDenoise',
      inputs: { sigmas: ['23', 0], denoise: SEAM_DENOISE },
    },
    '25': {
      class_type: 'RandomNoise',
      inputs: { noise_seed: seed + 1 },
    },
    '26': {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['25', 0],
        guider: ['9', 0],
        sampler: ['11', 0],
        sigmas: ['24', 1],
        latent_image: ['22', 0],
      },
    },
    '27': {
      class_type: 'VAEDecode',
      inputs: { samples: ['26', 0], vae: ['6', 0] },
    },
    ...rollNodes(28, ['27', 0]),
    '31': {
      class_type: 'SaveImage',
      inputs: { images: ['30', 0], filename_prefix: 'panorama' },
    },
  };
}

export type DitEngine = Exclude<PanoEngine, 'sdxl'>;

/** ONE customComfy step — all stock/baked nodes, so no snapshot step or layer cache. */
export function buildDitSeamlessTemplate(
  engine: DitEngine,
  body: PanoBody,
): Record<string, unknown> {
  const [resources, workflow] =
    engine === 'flux2-klein'
      ? [
          [FLUX2_DIFFUSION_AIR, FLUX2_CLIP_AIR, FLUX2_VAE_AIR, FLUX2_LORA_AIR],
          buildFlux2SeamlessGraph(body),
        ]
      : engine === 'qwen-image'
        ? [
            [QWEN_DIFFUSION_AIR, QWEN_CLIP_AIR, QWEN_VAE_AIR, QWEN_LORA_AIR],
            buildQwenSeamlessGraph(body),
          ]
        : [
            [ZIMAGE_DIFFUSION_AIR, ZIMAGE_CLIP_AIR, ZIMAGE_VAE_AIR, ZIMAGE_LORA_AIR],
            buildZimageSeamlessGraph(body),
          ];
  return {
    steps: [
      {
        $type: 'customComfy',
        name: GEN_STEP_NAME,
        timeout: '01:00:00',
        input: { resources, trace: 'binary', workflow },
      },
    ],
  };
}

export function buildZimageSeamlessTemplate(body: PanoBody): Record<string, unknown> {
  return buildDitSeamlessTemplate('zimage-turbo', body);
}

function ditNodeLabels(modelLabel: string): Record<string, string> {
  return {
    '1': `Loading ${modelLabel}`,
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
}

export const ZIMAGE_NODE_LABELS = ditNodeLabels('Z-Image Turbo');
export const QWEN_NODE_LABELS = ditNodeLabels('Qwen Image');

export const FLUX2_NODE_LABELS: Record<string, string> = {
  '1': 'Loading Flux2 Klein',
  '2': 'Applying 360 LoRA',
  '3': 'Loading text encoder',
  '4': 'Encoding prompt',
  '5': 'Encoding negative prompt',
  '6': 'Loading VAE',
  '7': 'Preparing canvas',
  '8': 'Tuning the sampler',
  '9': 'Tuning the sampler',
  '10': 'Tuning the sampler',
  '11': 'Tuning the sampler',
  '12': 'Sampling',
  '13': 'Decoding image',
  '14': 'Centering the seam',
  '15': 'Centering the seam',
  '16': 'Centering the seam',
  '17': 'Masking the seam',
  '18': 'Masking the seam',
  '19': 'Masking the seam',
  '20': 'Masking the seam',
  '21': 'Encoding for seam heal',
  '22': 'Masking the seam',
  '23': 'Tuning the sampler',
  '24': 'Tuning the sampler',
  '25': 'Tuning the sampler',
  '26': 'Healing the seam',
  '27': 'Decoding healed image',
  '28': 'Restoring the wrap',
  '29': 'Restoring the wrap',
  '30': 'Restoring the wrap',
  '31': 'Saving panorama',
};

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

/** `undefined` until the snapshot step has captured its install layer. */
export function extractLayerAir(doc: OrchestratorWorkflowDoc): string | undefined {
  const step = (doc.steps ?? []).find((s) => s.name === SNAPSHOT_STEP_NAME);
  const layerAir = step?.output?.results?.[0]?.layerAir;
  return typeof layerAir === 'string' && layerAir.length > 0 ? layerAir : undefined;
}
