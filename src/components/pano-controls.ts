// <pano-controls> — the generation form: scene presets, prompt, seed, mode
// toggle, and the Generate button. Emits `pano-generate` with a PanoRequest
// detail; <pano-app> owns submission. DOM is built once; property setters
// mutate in place so re-renders never clobber what the user is typing.

import type { PanoRequest } from '../controller.js';
import { SCENE_PRESETS, type PanoMode } from '../panorama.js';
import { formatCost } from '../generation.js';

export class PanoControls extends HTMLElement {
  #busy = false;
  #mode: PanoMode = 'hosted';
  #seamlessAvailable = false;
  #estimatedCost: number | null = null;
  #anon = false;

  #promptEl!: HTMLTextAreaElement;
  #seedEl!: HTMLInputElement;
  #generateBtn!: HTMLButtonElement;
  #presetBtns: HTMLButtonElement[] = [];
  #modeBtns = new Map<PanoMode, HTMLButtonElement>();
  #modeNote!: HTMLElement;

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

  /** Whether seamless (customComfy) mode can run against the current host. */
  set seamlessAvailable(value: boolean) {
    this.#seamlessAvailable = value;
    if (value && this.#mode === 'hosted') this.#mode = 'seamless';
    if (!value) this.#mode = 'hosted';
    this.#sync();
  }

  get mode(): PanoMode {
    return this.#mode;
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
    modeField.appendChild(el('span', 'pn-label', 'Seam'));
    const modeRow = el('div', 'pn-row');
    modeRow.setAttribute('role', 'radiogroup');
    modeRow.setAttribute('aria-label', 'Panorama mode');
    const modes: Array<{ mode: PanoMode; label: string }> = [
      { mode: 'seamless', label: 'Seamless wrap' },
      { mode: 'hosted', label: 'Standard' },
    ];
    for (const { mode, label } of modes) {
      const btn = el('button', 'pn-chip', label) as HTMLButtonElement;
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.dataset.testid = `pn-mode-${mode}`;
      btn.addEventListener('click', () => {
        if (mode === 'seamless' && !this.#seamlessAvailable) return;
        this.#mode = mode;
        this.#sync();
      });
      this.#modeBtns.set(mode, btn);
      modeRow.appendChild(btn);
    }
    this.#modeNote = el('span', 'pn-desc');
    modeField.append(modeRow, this.#modeNote);

    optionsRow.append(modeField, seedField);

    this.#generateBtn = el('button', 'pn-btn') as HTMLButtonElement;
    this.#generateBtn.type = 'button';
    this.#generateBtn.dataset.testid = 'pn-generate';
    this.#generateBtn.addEventListener('click', () => this.#emitGenerate());

    this.append(sceneField, optionsRow, this.#generateBtn);
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
      btn.disabled = this.#busy || (mode === 'seamless' && !this.#seamlessAvailable);
    }
    this.#modeNote.textContent = this.#seamlessAvailable
      ? this.#mode === 'seamless'
        ? 'Left and right edges wrap perfectly — no visible seam behind you.'
        : 'Standard generation: expect a visible seam where the edges meet.'
      : 'Seamless wrap needs the customComfy bridge (dev:orch) — this host runs standard generations, which show a seam where the edges meet.';
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
