// <pano-controls> — the generation form. DOM is built once; property setters
// mutate in place so re-renders never clobber typing.

import type { PanoRequest } from '../controller.js';
import { CHECKPOINT_DEFAULT_NAME, SCENE_PRESETS, type PanoMode } from '../panorama.js';
import { formatCost } from '../generation.js';

/** The picked-checkpoint display state <pano-app> projects in. */
export interface ControlsCheckpoint {
  name: string;
}

const MODE_NOTES: Record<PanoMode, string> = {
  seamless:
    'Truly seamless — the edges are painted as continuations of each other. Any SDXL checkpoint. ~30-90 Buzz.',
  zimage:
    'Z-Image Turbo — fastest and cheapest; the wrap seam is healed with an inpaint pass. ~15-25 Buzz.',
  flux2:
    'FLUX.2 Klein 9B — strong prompt following; the wrap seam is healed with an inpaint pass. ~30-60 Buzz.',
  qwen:
    'Qwen Image (20B) — best prompt adherence, slowest; the wrap seam is healed with an inpaint pass. ~120-180 Buzz.',
  hosted: 'Standard SDXL generation: expect a visible seam where the edges meet.',
};

/** Modes that run on an SDXL checkpoint (and can therefore pick one). */
const SDXL_MODES: ReadonlySet<PanoMode> = new Set(['seamless', 'hosted']);

export class PanoControls extends HTMLElement {
  #busy = false;
  #mode: PanoMode = 'hosted';
  #seamlessAvailable = false;
  #estimatedCost: number | null = null;
  #anon = false;
  #checkpoint: ControlsCheckpoint | null = null;

  #promptEl!: HTMLTextAreaElement;
  #seedEl!: HTMLInputElement;
  #generateBtn!: HTMLButtonElement;
  #presetBtns: HTMLButtonElement[] = [];
  #modeBtns = new Map<PanoMode, HTMLButtonElement>();
  #modeNote!: HTMLElement;
  #modelField!: HTMLElement;
  #modelNameEl!: HTMLElement;
  #modelChangeBtn!: HTMLButtonElement;
  #modelResetBtn!: HTMLButtonElement;

  connectedCallback(): void {
    if (this.#generateBtn) return;
    this.#build();
    this.#sync();
  }

  set busy(value: boolean) {
    this.#busy = value;
    this.#sync();
  }

  set anon(value: boolean) {
    this.#anon = value;
    this.#sync();
  }

  set estimatedCost(value: number | null) {
    this.#estimatedCost = value;
    this.#sync();
  }

  /** Whether the customComfy modes (all but Standard) can run against this host. */
  set seamlessAvailable(value: boolean) {
    this.#seamlessAvailable = value;
    if (value && this.#mode === 'hosted') this.#mode = 'seamless';
    if (!value && this.#mode !== 'hosted') this.#mode = 'hosted';
    this.#sync();
  }

  get mode(): PanoMode {
    return this.#mode;
  }

  /** The picked checkpoint (null = default). Set by <pano-app>. */
  set checkpoint(value: ControlsCheckpoint | null) {
    this.#checkpoint = value;
    this.#sync();
  }

  #build(): void {
    const sceneField = el('div', 'pn-field');
    sceneField.append(
      el('span', 'pn-label', 'Scene'),
      el('span', 'pn-desc', 'Open spaces with a clear horizon wrap best. Pick a preset or write your own.'),
    );

    const presetRow = el('div', 'pn-row');
    presetRow.setAttribute('role', 'radiogroup');
    presetRow.setAttribute('aria-label', 'Scene preset');
    for (const preset of SCENE_PRESETS) {
      const btn = el('button', 'pn-chip', preset.label) as HTMLButtonElement;
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.testid = `pn-preset-${preset.id}`;
      btn.addEventListener('click', () => {
        this.#promptEl.value = preset.prompt;
        this.#markPreset(btn);
      });
      this.#presetBtns.push(btn);
      presetRow.appendChild(btn);
    }
    sceneField.appendChild(presetRow);

    this.#promptEl = el('textarea', 'pn-textarea') as HTMLTextAreaElement;
    this.#promptEl.rows = 3;
    this.#promptEl.maxLength = 1500;
    this.#promptEl.placeholder = SCENE_PRESETS[0].prompt;
    this.#promptEl.dataset.testid = 'pn-prompt';
    this.#promptEl.addEventListener('input', () => this.#markPreset(null));
    sceneField.appendChild(this.#promptEl);

    const optionsRow = el('div', 'pn-row');

    const seedField = el('div', 'pn-field');
    seedField.appendChild(el('span', 'pn-label', 'Seed'));
    this.#seedEl = el('input', 'pn-input') as HTMLInputElement;
    this.#seedEl.type = 'number';
    this.#seedEl.min = '0';
    this.#seedEl.placeholder = 'random';
    this.#seedEl.style.width = '140px';
    this.#seedEl.dataset.testid = 'pn-seed';
    seedField.appendChild(this.#seedEl);

    const modeField = el('div', 'pn-field');
    modeField.appendChild(el('span', 'pn-label', 'Model'));
    const modeRow = el('div', 'pn-row');
    modeRow.setAttribute('role', 'radiogroup');
    modeRow.setAttribute('aria-label', 'Panorama model');
    const modes: Array<{ mode: PanoMode; label: string }> = [
      { mode: 'seamless', label: 'SDXL · Recommended' },
      { mode: 'zimage', label: 'Z-Image Turbo' },
      { mode: 'flux2', label: 'Flux2 Klein' },
      { mode: 'qwen', label: 'Qwen Image' },
      { mode: 'hosted', label: 'Standard' },
    ];
    for (const { mode, label } of modes) {
      const btn = el('button', 'pn-chip', label) as HTMLButtonElement;
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.dataset.testid = `pn-mode-${mode}`;
      btn.addEventListener('click', () => {
        if (mode !== 'hosted' && !this.#seamlessAvailable) return;
        if (this.#mode === mode) return;
        this.#mode = mode;
        this.#sync();
        this.dispatchEvent(
          new CustomEvent('pano-mode-change', { bubbles: true, detail: { mode } }),
        );
      });
      this.#modeBtns.set(mode, btn);
      modeRow.appendChild(btn);
    }
    this.#modeNote = el('span', 'pn-desc');
    modeField.append(modeRow, this.#modeNote);

    // SDXL checkpoint row — hidden in the DiT modes (each has one base model).
    this.#modelField = el('div', 'pn-field');
    this.#modelField.appendChild(el('span', 'pn-label', 'Checkpoint'));
    const modelRow = el('div', 'pn-row');
    this.#modelNameEl = el('span', 'pn-desc');
    this.#modelNameEl.dataset.testid = 'pn-model-name';
    this.#modelChangeBtn = el('button', 'pn-btn pn-btn--subtle', 'Change…') as HTMLButtonElement;
    this.#modelChangeBtn.type = 'button';
    this.#modelChangeBtn.dataset.testid = 'pn-model-change';
    this.#modelChangeBtn.addEventListener('click', () =>
      this.dispatchEvent(new CustomEvent('pano-pick-checkpoint', { bubbles: true })),
    );
    this.#modelResetBtn = el('button', 'pn-btn pn-btn--subtle', 'Reset') as HTMLButtonElement;
    this.#modelResetBtn.type = 'button';
    this.#modelResetBtn.dataset.testid = 'pn-model-reset';
    this.#modelResetBtn.addEventListener('click', () =>
      this.dispatchEvent(new CustomEvent('pano-reset-checkpoint', { bubbles: true })),
    );
    modelRow.append(this.#modelNameEl, this.#modelChangeBtn, this.#modelResetBtn);
    this.#modelField.appendChild(modelRow);

    this.#generateBtn = el('button', 'pn-btn') as HTMLButtonElement;
    this.#generateBtn.type = 'button';
    this.#generateBtn.dataset.testid = 'pn-generate';
    this.#generateBtn.addEventListener('click', () => this.#emitGenerate());

    optionsRow.append(modeField, seedField);
    this.append(sceneField, optionsRow, this.#modelField, this.#generateBtn);
  }

  #markPreset(active: HTMLButtonElement | null): void {
    for (const btn of this.#presetBtns) {
      btn.setAttribute('aria-checked', btn === active ? 'true' : 'false');
    }
  }

  #emitGenerate(): void {
    if (this.#anon) {
      this.dispatchEvent(new CustomEvent('pano-signin', { bubbles: true }));
      return;
    }
    const prompt = this.#promptEl.value.trim();
    if (!prompt) {
      this.#promptEl.focus();
      return;
    }
    const seedRaw = this.#seedEl.value.trim();
    const seed = seedRaw === '' ? undefined : Number(seedRaw);
    const detail: PanoRequest = {
      prompt,
      mode: this.#mode,
      ...(seed !== undefined && Number.isFinite(seed) ? { seed } : {}),
    };
    this.dispatchEvent(new CustomEvent('pano-generate', { bubbles: true, detail }));
  }

  #sync(): void {
    if (!this.#generateBtn) return;
    for (const [mode, btn] of this.#modeBtns) {
      btn.setAttribute('aria-checked', mode === this.#mode ? 'true' : 'false');
      btn.disabled = this.#busy || (mode !== 'hosted' && !this.#seamlessAvailable);
    }
    this.#modeNote.textContent = this.#seamlessAvailable
      ? MODE_NOTES[this.#mode]
      : 'Seamless modes need the customComfy bridge — this host runs standard generations, which show a seam where the edges meet.';

    this.#modelField.hidden = !SDXL_MODES.has(this.#mode);
    this.#modelNameEl.textContent = this.#checkpoint?.name ?? CHECKPOINT_DEFAULT_NAME;
    this.#modelChangeBtn.disabled = this.#busy;
    this.#modelResetBtn.disabled = this.#busy;
    this.#modelResetBtn.hidden = this.#checkpoint === null;

    this.#promptEl.disabled = this.#busy;
    this.#seedEl.disabled = this.#busy;
    for (const btn of this.#presetBtns) btn.disabled = this.#busy;
    this.#generateBtn.disabled = this.#busy;
    this.#generateBtn.textContent = this.#anon
      ? 'Sign in to generate'
      : this.#busy
        ? 'Rendering…'
        : `Generate 360° panorama · ~${formatCost(this.#estimatedCost)} Buzz`;
  }
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
