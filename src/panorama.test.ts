import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_AIR,
  CHECKPOINT_MODEL_ID,
  CHECKPOINT_VERSION_ID,
  GEN_STEP_NAME,
  LORA_AIR,
  LORA_STRENGTH,
  LORA_VERSION_ID,
  NODEPACK_AIR,
  NEGATIVE_PROMPT,
  PANO_HEIGHT,
  PANO_WIDTH,
  PROMPT_MAX,
  SEAM_BAND_PX,
  SEAM_DENOISE,
  SEAM_FEATHER_PX,
  SNAPSHOT_STEP_NAME,
  TRIGGER_WORDS,
  ZIMAGE_CLIP_AIR,
  ZIMAGE_DIFFUSION_AIR,
  ZIMAGE_LORA_AIR,
  ZIMAGE_TRIGGER_WORDS,
  ZIMAGE_VAE_AIR,
  buildHostedBody,
  buildPanoBody,
  buildSeamlessGraph,
  buildSeamlessTemplate,
  buildZimageSeamlessGraph,
  buildZimageSeamlessTemplate,
  clampPrompt,
  extractLayerAir,
  mapWorkflowToSnapshot,
  positivePrompt,
  sdxlCheckpointAir,
  type OrchestratorWorkflowDoc,
} from './panorama.js';

type Step = {
  $type: string;
  name?: string;
  input: { resources?: unknown[]; nodepacks?: string[]; workflow?: unknown; trace?: string };
};
const stepsOf = (template: Record<string, unknown>) => template.steps as Step[];

describe('buildPanoBody / prompts', () => {
  it('clamps the prompt and carries seed + account only when set', () => {
    const long = 'x'.repeat(PROMPT_MAX + 100);
    const body = buildPanoBody(`  ${long}  `);
    expect(body.kind).toBe('pano360');
    expect(body.prompt.length).toBe(PROMPT_MAX);
    expect('seed' in body).toBe(false);
    expect('accountType' in body).toBe(false);

    const withExtras = buildPanoBody('a lake', 42, 'yellow');
    expect(withExtras.seed).toBe(42);
    expect(withExtras.accountType).toBe('yellow');
  });

  it('positivePrompt = trigger words + scene + quality tail', () => {
    const p = positivePrompt('an icy lake');
    expect(p.startsWith(TRIGGER_WORDS)).toBe(true);
    expect(p).toContain('an icy lake');
    expect(clampPrompt('  padded  ')).toBe('padded');
  });
});

describe('buildSeamlessGraph', () => {
  const graph = buildSeamlessGraph(buildPanoBody('an icy lake', 1234));

  it('references the checkpoint and LoRA AIRs inline in loader widgets', () => {
    expect(graph['1'].class_type).toBe('CheckpointLoaderSimple');
    expect(graph['1'].inputs.ckpt_name).toBe(CHECKPOINT_AIR);
    expect(graph['2'].class_type).toBe('LoraLoader');
    expect(graph['2'].inputs.lora_name).toBe(LORA_AIR);
    expect(graph['2'].inputs.strength_model).toBe(LORA_STRENGTH);
  });

  it('applies the x-only seamless wrap on both the model and the VAE decode', () => {
    expect(graph['3']).toEqual({
      class_type: 'SeamlessTile',
      inputs: { model: ['2', 0], tiling: 'x_only', copy_model: 'Modify in place' },
    });
    expect(graph['8']).toEqual({
      class_type: 'MakeCircularVAE',
      inputs: { vae: ['1', 2], tiling: 'x_only', copy_vae: 'Modify in place' },
    });
    expect(graph['9']).toEqual({
      class_type: 'VAEDecode',
      inputs: { samples: ['7', 0], vae: ['8', 0] },
    });
    expect(graph['10'].class_type).toBe('SaveImage');
  });

  it('samples a 2:1 equirectangular canvas from the patched model', () => {
    expect(graph['6'].inputs).toMatchObject({ width: PANO_WIDTH, height: PANO_HEIGHT });
    expect(graph['7'].inputs.model).toEqual(['3', 0]);
    expect(graph['7'].inputs.seed).toBe(1234);
    expect(graph['4'].inputs.text).toBe(positivePrompt('an icy lake'));
    expect(graph['5'].inputs.text).toBe(NEGATIVE_PROMPT);
  });

  it('randomizes the seed when omitted', () => {
    const g = buildSeamlessGraph(buildPanoBody('a lake'));
    const seed = g['7'].inputs.seed as number;
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
  });
});

describe('buildSeamlessTemplate', () => {
  it('with no cached layer: 2-step snapshot + $ref-consuming customComfy', () => {
    const steps = stepsOf(buildSeamlessTemplate(buildPanoBody('a lake')));
    expect(steps).toHaveLength(2);

    const [snapshot, gen] = steps;
    expect(snapshot.$type).toBe('comfyNodepackSnapshot');
    expect(snapshot.name).toBe(SNAPSHOT_STEP_NAME);
    expect(snapshot.input.nodepacks).toEqual([NODEPACK_AIR]);

    expect(gen.$type).toBe('customComfy');
    expect(gen.name).toBe(GEN_STEP_NAME);
    expect(gen.input.trace).toBe('binary');
    expect(gen.input.resources).toEqual([
      { $ref: SNAPSHOT_STEP_NAME, path: 'output.results[0].layerAir' },
      CHECKPOINT_AIR,
      LORA_AIR,
    ]);
    expect(gen.input.workflow).toBeTruthy();
  });

  it('with a cached layer AIR: single-step submit with the layer inlined', () => {
    const layer = 'urn:air:comfy:nodepacklayer:comfyregistry:spinagon/comfyui-seamless-tiling@1.0.0+abcdef';
    const steps = stepsOf(buildSeamlessTemplate(buildPanoBody('a lake'), layer));
    expect(steps).toHaveLength(1);
    expect(steps[0].$type).toBe('customComfy');
    expect(steps[0].input.resources).toEqual([layer, CHECKPOINT_AIR, LORA_AIR]);
  });
});

describe('checkpoint override (picker result)', () => {
  const checkpoint = { modelId: 112902, versionId: 126688 };

  it('lands in the seamless graph loader AND the template resources', () => {
    const body = buildPanoBody('a lake', undefined, undefined, { checkpoint });
    const air = sdxlCheckpointAir(checkpoint);
    expect(air).toBe('urn:air:sdxl:checkpoint:civitai:112902@126688');

    const graph = buildSeamlessGraph(body);
    expect(graph['1'].inputs.ckpt_name).toBe(air);

    const steps = stepsOf(buildSeamlessTemplate(body, 'urn:air:layer'));
    expect(steps[0].input.resources).toContain(air);
    expect(steps[0].input.resources).not.toContain(CHECKPOINT_AIR);

    const twoStep = stepsOf(buildSeamlessTemplate(body));
    expect(twoStep[1].input.resources).toContain(air);
  });

  it('swaps the hosted body model ids', () => {
    const body = buildHostedBody('a lake', undefined, undefined, checkpoint);
    expect(body.modelId).toBe(112902);
    expect(body.modelVersionId).toBe(126688);
  });

  it('buildPanoBody drops the checkpoint for the zimage engine', () => {
    const body = buildPanoBody('a lake', undefined, undefined, {
      engine: 'zimage-turbo',
      checkpoint,
    });
    expect(body.engine).toBe('zimage-turbo');
    expect('checkpoint' in body).toBe(false);
  });
});

describe('buildZimageSeamlessGraph', () => {
  const graph = buildZimageSeamlessGraph(
    buildPanoBody('an icy lake', 42, undefined, { engine: 'zimage-turbo' }),
  );

  it('mirrors the worker Z-Image recipe: split loaders, lumina2 clip, shift 3', () => {
    expect(graph['1']).toEqual({
      class_type: 'UNETLoader',
      inputs: { unet_name: ZIMAGE_DIFFUSION_AIR, weight_dtype: 'default' },
    });
    expect(graph['2'].class_type).toBe('LoraLoaderModelOnly');
    expect(graph['2'].inputs.lora_name).toBe(ZIMAGE_LORA_AIR);
    expect(graph['3']).toEqual({
      class_type: 'ModelSamplingAuraFlow',
      inputs: { model: ['2', 0], shift: 3.0 },
    });
    expect(graph['4'].inputs).toMatchObject({ clip_name: ZIMAGE_CLIP_AIR, type: 'lumina2' });
    expect(graph['7'].inputs.vae_name).toBe(ZIMAGE_VAE_AIR);
    expect(graph['8'].class_type).toBe('EmptySD3LatentImage');
  });

  it('turbo sampling: 8 steps, cfg 1, euler/simple, inert negative', () => {
    expect(graph['9'].inputs).toMatchObject({
      seed: 42,
      steps: 8,
      cfg: 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1.0,
    });
    expect(graph['5'].inputs.text).toBe(ZIMAGE_TRIGGER_WORDS + 'an icy lake' + ', ultra detailed, masterpiece, best quality');
    expect(graph['6'].inputs.text).toBe('');
  });

  it('rolls 50% via crop+stitch with the halves swapped (seam to center)', () => {
    const half = PANO_WIDTH / 2;
    expect(graph['11'].inputs).toMatchObject({ image: ['10', 0], x: 0, width: half });
    expect(graph['12'].inputs).toMatchObject({ image: ['10', 0], x: half, width: half });
    expect(graph['13'].class_type).toBe('ImageStitch');
    expect(graph['13'].inputs.image1).toEqual(['12', 0]); // right half first
    expect(graph['13'].inputs.image2).toEqual(['11', 0]);
    expect(graph['13'].inputs.direction).toBe('right');
  });

  it('builds a centered feathered band mask', () => {
    expect(graph['14'].inputs).toMatchObject({ value: 0, width: PANO_WIDTH, height: PANO_HEIGHT });
    expect(graph['15'].inputs).toMatchObject({ value: 1, width: SEAM_BAND_PX });
    expect(graph['16'].inputs).toMatchObject({
      x: (PANO_WIDTH - SEAM_BAND_PX) / 2,
      operation: 'add',
    });
    expect(graph['17'].inputs).toMatchObject({ left: SEAM_FEATHER_PX, right: SEAM_FEATHER_PX });
  });

  it('heals the band with a partial-denoise pass and rolls back', () => {
    expect(graph['18']).toEqual({
      class_type: 'VAEEncode',
      inputs: { pixels: ['13', 0], vae: ['7', 0] },
    });
    expect(graph['19']).toEqual({
      class_type: 'SetLatentNoiseMask',
      inputs: { samples: ['18', 0], mask: ['17', 0] },
    });
    expect(graph['20'].inputs).toMatchObject({
      latent_image: ['19', 0],
      denoise: SEAM_DENOISE,
      seed: 43,
      cfg: 1,
    });
    expect(graph['21'].inputs.samples).toEqual(['20', 0]);
    // roll back: same involution over the healed image
    expect(graph['22'].inputs.image).toEqual(['21', 0]);
    expect(graph['24'].inputs.image1).toEqual(['23', 0]);
    expect(graph['25']).toMatchObject({
      class_type: 'SaveImage',
      inputs: { images: ['24', 0] },
    });
  });
});

describe('buildZimageSeamlessTemplate', () => {
  it('is ONE stock-node step: no snapshot, exactly the four model AIRs', () => {
    const steps = stepsOf(
      buildZimageSeamlessTemplate(buildPanoBody('a lake', 1, undefined, { engine: 'zimage-turbo' })),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].$type).toBe('customComfy');
    expect(steps[0].name).toBe(GEN_STEP_NAME);
    expect(steps[0].input.trace).toBe('binary');
    expect(steps[0].input.resources).toEqual([
      ZIMAGE_DIFFUSION_AIR,
      ZIMAGE_CLIP_AIR,
      ZIMAGE_VAE_AIR,
      ZIMAGE_LORA_AIR,
    ]);
  });
});

describe('buildHostedBody', () => {
  it('stays inside the block bridge caps (DIM_MAX 2048, steps ≤ 50, ≤ 5 LoRAs)', () => {
    const body = buildHostedBody('a lake', 7, 'blue');
    expect(body.kind).toBe('textToImage');
    expect(body.modelId).toBe(CHECKPOINT_MODEL_ID);
    expect(body.modelVersionId).toBe(CHECKPOINT_VERSION_ID);
    expect(body.additionalResources).toEqual([
      { modelVersionId: LORA_VERSION_ID, strength: LORA_STRENGTH },
    ]);
    expect(body.params.width).toBeLessThanOrEqual(2048);
    expect(body.params.height).toBeLessThanOrEqual(2048);
    expect(body.params.steps).toBeLessThanOrEqual(50);
    expect(body.params.prompt.startsWith(TRIGGER_WORDS)).toBe(true);
    expect(body.params.seed).toBe(7);
    expect(body.accountType).toBe('blue');
  });

  it('omits seed/account when not set', () => {
    const body = buildHostedBody('a lake');
    expect('seed' in body.params).toBe(false);
    expect('accountType' in body).toBe(false);
  });
});

describe('mapWorkflowToSnapshot', () => {
  it('maps status, cost, and flattens available blob urls across steps', () => {
    const doc: OrchestratorWorkflowDoc = {
      id: 'wf_1',
      status: 'succeeded',
      cost: { total: 47 },
      steps: [
        { name: 'snapshot', output: { results: [{ layerAir: 'urn:air:layer' }] } },
        { name: 'pano', output: { blobs: [{ url: 'https://blob/1' }, {}] } },
      ],
    };
    const snap = mapWorkflowToSnapshot(doc);
    expect(snap).toMatchObject({
      workflowId: 'wf_1',
      status: 'succeeded',
      cost: { total: 47 },
      imageUrls: ['https://blob/1'],
    });
  });

  it('unknown/absent status maps to pending; processing passes through', () => {
    expect(mapWorkflowToSnapshot({}).status).toBe('pending');
    expect(mapWorkflowToSnapshot({ status: 'processing' }).status).toBe('processing');
  });

  it('failed with insufficientBuzz surfaces the Buzz error', () => {
    const snap = mapWorkflowToSnapshot({
      status: 'failed',
      transactions: { insufficientBuzz: true },
    });
    expect(snap.error).toMatch(/Insufficient Buzz/);
  });

  it('failed surfaces the first step error, else a generic message', () => {
    const withStep = mapWorkflowToSnapshot({
      status: 'failed',
      steps: [{ metadata: { error: 'node type not found: SeamlessTile' } }],
    });
    expect(withStep.error).toBe('node type not found: SeamlessTile');
    expect(mapWorkflowToSnapshot({ status: 'canceled' }).error).toBe('Generation canceled.');
  });
});

describe('extractLayerAir', () => {
  it('reads the snapshot step output; undefined when absent', () => {
    const doc: OrchestratorWorkflowDoc = {
      steps: [
        { name: 'snapshot', output: { results: [{ layerAir: 'urn:air:comfy:nodepacklayer:x@1+ff' }] } },
        { name: 'pano' },
      ],
    };
    expect(extractLayerAir(doc)).toBe('urn:air:comfy:nodepacklayer:x@1+ff');
    expect(extractLayerAir({ steps: [{ name: 'pano' }] })).toBeUndefined();
    expect(extractLayerAir({})).toBeUndefined();
  });
});
