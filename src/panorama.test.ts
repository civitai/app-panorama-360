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
  PANO_CFG,
  PANO_HEIGHT,
  PANO_STEPS,
  PANO_WIDTH,
  PROMPT_MAX,
  SEAM_BAND_PX,
  SEAM_DENOISE,
  SEAM_FEATHER_PX,
  SNAPSHOT_STEP_NAME,
  TRIGGER_WORDS,
  FLUX2_CFG,
  FLUX2_CLIP_AIR,
  FLUX2_DIFFUSION_AIR,
  FLUX2_LORA_AIR,
  FLUX2_STEPS,
  FLUX2_TRIGGER_WORDS,
  FLUX2_VAE_AIR,
  QWEN_CLIP_AIR,
  QWEN_DIFFUSION_AIR,
  QWEN_LORA_AIR,
  QWEN_TRIGGER_WORDS,
  QWEN_VAE_AIR,
  SEAM_STEPS,
  ZIMAGE_CLIP_AIR,
  ZIMAGE_DIFFUSION_AIR,
  ZIMAGE_LORA_AIR,
  ZIMAGE_TRIGGER_WORDS,
  ZIMAGE_VAE_AIR,
  CUSTOM_COMFY_RECIPE,
  buildCustomComfyBody,
  buildDitSeamlessTemplate,
  buildFlux2SeamlessGraph,
  buildHostedBody,
  buildPanoBody,
  customComfyToPanoBody,
  isCustomComfyBody,
  buildQwenSeamlessGraph,
  buildSeamlessGraph,
  buildSeamlessTemplate,
  buildStandardTemplate,
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

describe('buildCustomComfyBody (real-bridge recipe body)', () => {
  it('sdxl seamless: bounded recipe, engine omitted (recipe default), prompt clamped', () => {
    const long = 'x'.repeat(PROMPT_MAX + 100);
    const body = buildCustomComfyBody(`  ${long}  `);
    expect(body.kind).toBe('customComfy');
    expect(body.recipe).toBe(CUSTOM_COMFY_RECIPE);
    expect(body.recipe).toBe('seamless-pano-360');
    expect(body.params.prompt.length).toBe(PROMPT_MAX);
    expect('engine' in body.params).toBe(false);
    expect('seed' in body.params).toBe(false);
    expect('accountType' in body.params).toBe(false);
    // The bounded recipe owns the checkpoint server-side — no override field.
    expect(body).not.toHaveProperty('checkpoint');
  });

  it('carries seed, accountType and the DiT engine when set', () => {
    const body = buildCustomComfyBody('a lake', 42, 'yellow', 'zimage-turbo');
    expect(body.params).toEqual({
      prompt: 'a lake',
      seed: 42,
      accountType: 'yellow',
      engine: 'zimage-turbo',
    });
  });

  it('passes each DiT engine straight through as the recipe enum', () => {
    expect(buildCustomComfyBody('s', undefined, undefined, 'flux2-klein').params.engine).toBe(
      'flux2-klein',
    );
    expect(buildCustomComfyBody('s', undefined, undefined, 'qwen-image').params.engine).toBe(
      'qwen-image',
    );
  });
});

describe('isCustomComfyBody', () => {
  it('accepts only the bounded recipe body', () => {
    expect(isCustomComfyBody(buildCustomComfyBody('a lake'))).toBe(true);
    expect(isCustomComfyBody(buildPanoBody('a lake'))).toBe(false);
    expect(isCustomComfyBody(buildHostedBody('a lake'))).toBe(false);
    expect(isCustomComfyBody({ kind: 'customComfy', recipe: 'other', params: {} })).toBe(false);
    expect(isCustomComfyBody(null)).toBe(false);
  });
});

describe('customComfyToPanoBody (dev:orch fallback translation)', () => {
  it('sdxl (no engine) → pano360 body, no engine, default checkpoint', () => {
    const pano = customComfyToPanoBody(buildCustomComfyBody('a lake', 7, 'green'));
    expect(pano).toEqual({ kind: 'pano360', prompt: 'a lake', seed: 7, accountType: 'green' });
    expect('engine' in pano).toBe(false);
    expect('checkpoint' in pano).toBe(false);
  });

  it('carries the DiT engine so the fallback picks the right template', () => {
    const pano = customComfyToPanoBody(buildCustomComfyBody('a lake', undefined, undefined, 'qwen-image'));
    expect(pano.engine).toBe('qwen-image');
    expect('seed' in pano).toBe(false);
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

describe('buildStandardTemplate (dev:orch Standard-mode translation)', () => {
  it('translates the hosted body into a plain single-step graph — no wrap nodes', () => {
    const hosted = buildHostedBody('a lake', 9, undefined, { modelId: 112902, versionId: 126688 });
    const steps = stepsOf(buildStandardTemplate(hosted as never));
    expect(steps).toHaveLength(1);
    expect(steps[0].$type).toBe('customComfy');
    const air = 'urn:air:sdxl:checkpoint:civitai:112902@126688';
    expect(steps[0].input.resources).toEqual([air, LORA_AIR]);

    const graph = steps[0].input.workflow as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    expect(graph['1'].inputs.ckpt_name).toBe(air);
    expect(graph['2'].inputs.lora_name).toBe(LORA_AIR);
    expect(graph['4'].inputs.text).toBe(positivePrompt('a lake'));
    expect(graph['7'].inputs).toMatchObject({ seed: 9, steps: PANO_STEPS, cfg: PANO_CFG });
    const classTypes = Object.values(graph).map((n) => n.class_type);
    expect(classTypes).not.toContain('SeamlessTile');
    expect(classTypes).not.toContain('MakeCircularVAE');
    expect(graph['9'].inputs.vae).toEqual(['1', 2]);
  });

  it('omits the LoRA chain when no known additionalResource rides the body', () => {
    const hosted = { ...buildHostedBody('a lake') } as never as {
      additionalResources?: unknown;
    };
    delete hosted.additionalResources;
    const steps = stepsOf(buildStandardTemplate(hosted as never));
    const graph = steps[0].input.workflow as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    expect(graph['2']).toBeUndefined();
    expect(graph['7'].inputs.model).toEqual(['1', 0]);
    expect(steps[0].input.resources).toHaveLength(1);
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

describe('buildQwenSeamlessGraph', () => {
  const graph = buildQwenSeamlessGraph(
    buildPanoBody('an icy lake', 42, undefined, { engine: 'qwen-image' }),
  );

  it('loads the prod-warm 2512 GGUF with the sdpa attention override (sage breaks qwen)', () => {
    expect(graph['1'].class_type).toBe('GGUFLoaderKJ');
    expect(graph['1'].inputs).toMatchObject({
      model_name: QWEN_DIFFUSION_AIR,
      attention_override: 'sdpa',
    });
    expect(graph['2'].inputs.lora_name).toBe(QWEN_LORA_AIR);
    expect(graph['3'].inputs).toMatchObject({ shift: 3.1 });
    expect(graph['4'].inputs).toMatchObject({ clip_name: QWEN_CLIP_AIR, type: 'qwen_image' });
    expect(graph['7'].inputs.vae_name).toBe(QWEN_VAE_AIR);
  });

  it('quality sampling: 20 steps, cfg 2.5, ACTIVE negative prompt', () => {
    expect(graph['9'].inputs).toMatchObject({
      seed: 42,
      steps: 20,
      cfg: 2.5,
      sampler_name: 'euler',
      scheduler: 'simple',
    });
    expect(graph['5'].inputs.text).toBe(
      QWEN_TRIGGER_WORDS + 'an icy lake' + ', ultra detailed, masterpiece, best quality',
    );
    expect(graph['6'].inputs.text).toBe(NEGATIVE_PROMPT);
    expect(graph['20'].inputs).toMatchObject({ cfg: 2.5, denoise: SEAM_DENOISE, seed: 43 });
  });

  it('shares the exact roll/mask/heal node shape with the Z-Image graph (loader aside)', () => {
    const zimage = buildZimageSeamlessGraph(
      buildPanoBody('an icy lake', 42, undefined, { engine: 'zimage-turbo' }),
    );
    expect(Object.keys(graph)).toEqual(Object.keys(zimage));
    for (const id of Object.keys(graph)) {
      if (id === '1') continue;
      expect(graph[id].class_type).toBe(zimage[id].class_type);
    }
  });
});

describe('buildFlux2SeamlessGraph', () => {
  const graph = buildFlux2SeamlessGraph(
    buildPanoBody('an icy lake', 42, undefined, { engine: 'flux2-klein' }),
  );

  it('loads the prod 9b-kv model set with the flux2 clip type', () => {
    expect(graph['1']).toEqual({
      class_type: 'UNETLoader',
      inputs: { unet_name: FLUX2_DIFFUSION_AIR, weight_dtype: 'default' },
    });
    expect(graph['2'].inputs.lora_name).toBe(FLUX2_LORA_AIR);
    expect(graph['3'].inputs).toMatchObject({ clip_name: FLUX2_CLIP_AIR, type: 'flux2' });
    expect(graph['6'].inputs.vae_name).toBe(FLUX2_VAE_AIR);
    expect(graph['7'].class_type).toBe('EmptyFlux2LatentImage');
    expect(graph['4'].inputs.text).toBe(
      FLUX2_TRIGGER_WORDS + 'an icy lake' + ', ultra detailed, masterpiece, best quality',
    );
    expect(graph['5'].inputs.text).toBe(NEGATIVE_PROMPT);
  });

  it('samples with the fleet stack: Flux2Scheduler + CFGGuider + SamplerCustomAdvanced', () => {
    expect(graph['8']).toEqual({
      class_type: 'Flux2Scheduler',
      inputs: { steps: FLUX2_STEPS, width: PANO_WIDTH, height: PANO_HEIGHT },
    });
    expect(graph['9']).toEqual({
      class_type: 'CFGGuider',
      inputs: { model: ['2', 0], positive: ['4', 0], negative: ['5', 0], cfg: FLUX2_CFG },
    });
    expect(graph['10'].inputs.noise_seed).toBe(42);
    expect(graph['12']).toEqual({
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['10', 0],
        guider: ['9', 0],
        sampler: ['11', 0],
        sigmas: ['8', 0],
        latent_image: ['7', 0],
      },
    });
    expect(graph['13'].inputs).toEqual({ samples: ['12', 0], vae: ['6', 0] });
  });

  it('seam pass takes its partial denoise from SplitSigmasDenoise low_sigmas', () => {
    expect(graph['23'].inputs).toMatchObject({ steps: SEAM_STEPS });
    expect(graph['24']).toEqual({
      class_type: 'SplitSigmasDenoise',
      inputs: { sigmas: ['23', 0], denoise: SEAM_DENOISE },
    });
    expect(graph['25'].inputs.noise_seed).toBe(43);
    expect(graph['26'].inputs).toEqual({
      noise: ['25', 0],
      guider: ['9', 0], // shared with the base pass
      sampler: ['11', 0],
      sigmas: ['24', 1], // low_sigmas
      latent_image: ['22', 0],
    });
  });

  it('rolls, masks, heals, rolls back, and saves', () => {
    const half = PANO_WIDTH / 2;
    expect(graph['14'].inputs).toMatchObject({ image: ['13', 0], x: 0, width: half });
    expect(graph['15'].inputs).toMatchObject({ image: ['13', 0], x: half, width: half });
    expect(graph['16'].inputs.image1).toEqual(['15', 0]);
    expect(graph['17'].inputs).toMatchObject({ value: 0, width: PANO_WIDTH });
    expect(graph['19'].inputs).toMatchObject({ x: (PANO_WIDTH - SEAM_BAND_PX) / 2 });
    expect(graph['20'].inputs).toMatchObject({ left: SEAM_FEATHER_PX, right: SEAM_FEATHER_PX });
    expect(graph['21'].inputs).toEqual({ pixels: ['16', 0], vae: ['6', 0] });
    expect(graph['22'].inputs).toEqual({ samples: ['21', 0], mask: ['20', 0] });
    expect(graph['28'].inputs.image).toEqual(['27', 0]);
    expect(graph['30'].inputs.image1).toEqual(['29', 0]);
    expect(graph['31']).toMatchObject({
      class_type: 'SaveImage',
      inputs: { images: ['30', 0] },
    });
  });
});

describe('buildDitSeamlessTemplate', () => {
  it('qwen-image: single stock-node step with the four Qwen AIRs', () => {
    const steps = stepsOf(
      buildDitSeamlessTemplate(
        'qwen-image',
        buildPanoBody('a lake', 1, undefined, { engine: 'qwen-image' }),
      ),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].input.trace).toBe('binary');
    expect(steps[0].input.resources).toEqual([
      QWEN_DIFFUSION_AIR,
      QWEN_CLIP_AIR,
      QWEN_VAE_AIR,
      QWEN_LORA_AIR,
    ]);
  });

  it('flux2-klein: single stock-node step with the four Klein AIRs', () => {
    const steps = stepsOf(
      buildDitSeamlessTemplate(
        'flux2-klein',
        buildPanoBody('a lake', 1, undefined, { engine: 'flux2-klein' }),
      ),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].input.trace).toBe('binary');
    expect(steps[0].input.resources).toEqual([
      FLUX2_DIFFUSION_AIR,
      FLUX2_CLIP_AIR,
      FLUX2_VAE_AIR,
      FLUX2_LORA_AIR,
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
