import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  FLUX2_ESTIMATE_BUZZ,
  PANORAMA_ESTIMATE_BUZZ,
  QWEN_ESTIMATE_BUZZ,
  ZIMAGE_ESTIMATE_BUZZ,
} from './panorama';

/**
 * 🔴 `page.buzzBudgetPerGen` IS A SAFETY CEILING, NOT A COST ESTIMATE.
 *
 * The canonical schema (https://civitai.com/schemas/app-block/v1.json) says to
 * size it "WELL ABOVE your worst-case generation (a good rule of thumb is
 * several times your expected cost — e.g. 1000 when a run costs ~100), never at
 * your estimate. Setting it to an estimate is the common mistake."
 *
 * The failure mode is asymmetric. A budget that is too high costs nothing: the
 * seamless arms bill post-paid per GPU second and the real ceiling is clamped
 * and enforced server-side at mint, so the manifest number only ever caps. A
 * budget that real cost drifts past makes the host reject EVERY submit with
 * `insufficient buzz budget` — broken for every viewer, and unbreakable without
 * writing a new manifest version AND getting it re-approved by a moderator.
 * Outage on one side, nothing on the other.
 *
 * So this pins the RELATIONSHIP, not the number. `toBe(1000)` would pass while
 * the thing worth knowing rotted: raise an estimate constant and the literal
 * guard stays green right up to the outage. Reading the estimates from source
 * means a future raise has to move the budget with it or turn this red.
 *
 * All four arms are enumerated rather than just today's most expensive one —
 * which arm leads is a fact about the current model set, and the guard must not
 * quietly stop watching the one that overtakes it.
 */
const PER_MODEL_ESTIMATE_BUZZ: Readonly<Record<string, number>> = {
  standard: PANORAMA_ESTIMATE_BUZZ,
  zimage: ZIMAGE_ESTIMATE_BUZZ,
  qwen: QWEN_ESTIMATE_BUZZ,
  flux2: FLUX2_ESTIMATE_BUZZ,
};

/** "Several times your expected cost" — the floor this guard holds the budget to. */
const MIN_HEADROOM_MULTIPLE = 3;

function manifestBuzzBudgetPerGen(): number {
  const raw = readFileSync(new URL('../block.manifest.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { page?: { buzzBudgetPerGen?: unknown } };
  const budget = parsed.page?.buzzBudgetPerGen;
  if (typeof budget !== 'number' || !Number.isFinite(budget)) {
    // A missing or non-numeric budget is exactly the state this guard exists to
    // notice, so it fails loudly rather than comparing undefined and going green.
    throw new Error('block.manifest.json has no numeric "page.buzzBudgetPerGen"');
  }
  return budget;
}

describe('page.buzzBudgetPerGen', () => {
  it(`leaves at least ${MIN_HEADROOM_MULTIPLE}x headroom over the largest per-model estimate`, () => {
    const estimates = Object.values(PER_MODEL_ESTIMATE_BUZZ);
    const largestEstimate = Math.max(...estimates);
    // Guards the guard: a max of 0 would make the assertion below vacuously
    // true for any budget, which is how this file would silently stop testing.
    expect(largestEstimate).toBeGreaterThan(0);

    expect(manifestBuzzBudgetPerGen()).toBeGreaterThanOrEqual(
      MIN_HEADROOM_MULTIPLE * largestEstimate,
    );
  });
});
