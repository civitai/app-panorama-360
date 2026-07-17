// Elements barrel (`@civitai/comfy-run-kit/elements`).

import { BuzzMeterElement } from './elements/buzz-meter-element.js';
import { ComfyRunElement } from './elements/comfy-run.js';
import { RunLogsElement } from './elements/run-logs.js';
import { RunPreviewElement } from './elements/run-preview.js';
import { RunStatusElement } from './elements/run-status.js';

export { RunStateElement } from './elements/base.js';
export { RUN_CANCEL_EVENT } from './elements/run-status.js';
export { BuzzMeterElement, ComfyRunElement, RunLogsElement, RunPreviewElement, RunStatusElement };

const DEFINITIONS: ReadonlyArray<[string, CustomElementConstructor]> = [
  ['civitai-run-status', RunStatusElement],
  ['civitai-buzz-meter', BuzzMeterElement],
  ['civitai-run-preview', RunPreviewElement],
  ['civitai-run-logs', RunLogsElement],
  ['civitai-comfy-run', ComfyRunElement],
];

export function registerRunElements(): void {
  for (const [name, ctor] of DEFINITIONS) {
    if (!customElements.get(name)) customElements.define(name, ctor);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'civitai-run-status': RunStatusElement;
    'civitai-buzz-meter': BuzzMeterElement;
    'civitai-run-preview': RunPreviewElement;
    'civitai-run-logs': RunLogsElement;
    'civitai-comfy-run': ComfyRunElement;
  }
}
