// <pano-app> — root shell. Projects session/controller state into children
// via properties; child intents arrive as bubbling CustomEvents.

import { RUN_CANCEL_EVENT } from '@civitai/comfy-run-kit/elements';

import {
  GenerationController,
  MODE_ESTIMATE_BUZZ,
  type ControllerState,
  type PanoRequest,
} from '../controller.js';
import { createBlockSession, type BlockSession, type BuzzBalance } from '../transport.js';
import { formatCost } from '../generation.js';
import type { PanoCheckpoint, PanoMode } from '../panorama.js';
import type { PanoControls } from './pano-controls.js';
import type { PanoGallery } from './pano-gallery.js';
import type { PanoStatus } from './pano-status.js';
import type { PanoViewer } from './pano-viewer.js';

// customComfy modes need a host that understands the proposed `pano360` kind —
// today that's the dev orch harness; the mock harness simulates any body.
const SEAMLESS_AVAILABLE =
  import.meta.env.VITE_DEV_HARNESS === 'true' &&
  import.meta.env.VITE_HARNESS_MODE !== 'live';

export class PanoApp extends HTMLElement {
  /** Injectable for tests; defaults to the real transport-backed session. */
  session: BlockSession | null = null;
  /** Injectable for tests; defaults to the harness-mode computation above. */
  seamlessAvailable = SEAMLESS_AVAILABLE;

  #controller: GenerationController | null = null;
  #controls!: PanoControls;
  #status!: PanoStatus;
  #viewer!: PanoViewer;
  #gallery!: PanoGallery;
  #balanceEl!: HTMLElement;
  #loadingEl!: HTMLElement;
  #cardEl!: HTMLElement;
  #unsubscribers: Array<() => void> = [];
  #resizeObserver: ResizeObserver | null = null;
  #consentPending = false;
  #pendingRequest: PanoRequest | null = null;
  #finished: string[] = [];
  #shownUrl: string | null = null;
  #wasReady = false;
  #lastPhase: ControllerState['phase'] | null = null;
  #checkpoint: (PanoCheckpoint & { name: string }) | null = null;

  connectedCallback(): void {
    if (this.#cardEl) return;
    const session = (this.session ??= createBlockSession());
    this.#controller = new GenerationController(session);

    this.#build();

    this.#unsubscribers.push(
      session.subscribe(() => this.#onSessionChange()),
      this.#controller.subscribe((state) => this.#onControllerChange(state)),
    );
    this.#onSessionChange();
    this.#onControllerChange(this.#controller.getState());

    this.addEventListener('pano-generate', ((e: CustomEvent<PanoRequest>) =>
      this.#onGenerate(e.detail)) as EventListener);
    this.addEventListener(RUN_CANCEL_EVENT, () => this.#controller?.cancel());
    this.addEventListener('pano-signin', () => session.requestSignIn());
    this.addEventListener('pano-pick-checkpoint', () => void this.#pickCheckpoint());
    this.addEventListener('pano-reset-checkpoint', () => {
      this.#checkpoint = null;
      this.#controls.checkpoint = null;
    });
    this.addEventListener('pano-mode-change', ((e: CustomEvent<{ mode: PanoMode }>) => {
      this.#controls.estimatedCost = MODE_ESTIMATE_BUZZ[e.detail.mode];
    }) as EventListener);
    this.addEventListener('pano-select', ((e: CustomEvent<{ url: string }>) => {
      this.#shownUrl = e.detail.url;
      this.#viewer.src = e.detail.url;
      this.#gallery.selected = e.detail.url;
    }) as EventListener);

    this.#resizeObserver = new ResizeObserver(() => {
      session.resize(Math.ceil(document.documentElement.scrollHeight));
    });
    this.#resizeObserver.observe(this);
  }

  disconnectedCallback(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    this.#resizeObserver?.disconnect();
    this.#controller?.stopPolling();
  }

  #build(): void {
    this.#cardEl = document.createElement('div');
    this.#cardEl.className = 'pn-card';

    const header = document.createElement('div');
    header.className = 'pn-header';

    // Brand mark: a globe/360 glyph (matches the manifest icon + favicon),
    // tinted primary on primary-light — pure token color, flips with the theme.
    const brand = document.createElement('div');
    brand.className = 'pn-brand';
    brand.setAttribute('aria-hidden', 'true');
    brand.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"' +
      ' stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="9"/>' +
      '<ellipse cx="12" cy="12" rx="9" ry="3.6"/>' +
      '<path d="M12 3v18"/></svg>';

    const headerText = document.createElement('div');
    headerText.className = 'pn-header-text';
    const title = document.createElement('h1');
    title.className = 'pn-title';
    title.textContent = '360° Panorama Studio';
    const desc = document.createElement('span');
    desc.className = 'pn-desc';
    desc.textContent =
      'Describe a scene, generate a 2:1 equirectangular panorama, then drag to stand inside it.';
    headerText.append(title, desc);
    header.append(brand, headerText);

    this.#loadingEl = document.createElement('div');
    this.#loadingEl.className = 'pn-alert pn-alert--info';
    this.#loadingEl.textContent = 'Connecting to host…';

    this.#balanceEl = document.createElement('div');
    this.#balanceEl.className = 'pn-balance';
    this.#balanceEl.setAttribute('role', 'group');
    this.#balanceEl.setAttribute('aria-label', 'Buzz balance');
    this.#balanceEl.style.display = 'none';

    this.#viewer = document.createElement('pano-viewer') as PanoViewer;
    this.#gallery = document.createElement('pano-gallery') as PanoGallery;
    this.#controls = document.createElement('pano-controls') as PanoControls;
    this.#status = document.createElement('pano-status') as PanoStatus;

    this.#cardEl.append(
      header,
      this.#loadingEl,
      this.#balanceEl,
      this.#viewer,
      this.#gallery,
      this.#controls,
      this.#status,
    );
    this.appendChild(this.#cardEl);

    this.#controls.seamlessAvailable = this.seamlessAvailable;
  }

  #onSessionChange(): void {
    const session = this.session!;
    const snapshot = session.getSnapshot();

    document.documentElement.dataset.theme = snapshot.theme === 'light' ? 'light' : 'dark';
    this.#loadingEl.style.display = snapshot.ready ? 'none' : '';
    this.#controls.anon = snapshot.ready && !snapshot.viewer;

    if (snapshot.ready && !this.#wasReady) {
      this.#wasReady = true;
      void this.#refreshBalance();
    }

    // Lazy-consent round-trip: the host granted the budgeted scope after our
    // REQUEST_CONSENT — run the generation the user already asked for.
    if (this.#consentPending && session.canGenerate() && this.#pendingRequest) {
      this.#consentPending = false;
      const request = this.#pendingRequest;
      this.#pendingRequest = null;
      void this.#controller!.generate(request);
    }
  }

  #onControllerChange(state: ControllerState): void {
    this.#controls.busy = state.phase === 'estimating' || state.phase === 'submitting' || state.phase === 'polling';
    this.#controls.estimatedCost = state.estimatedCost;
    this.#status.state = state;

    const latest = state.imageUrl;
    if (latest && latest !== this.#shownUrl) {
      this.#shownUrl = latest;
      this.#viewer.src = latest;
    }

    if (state.phase === 'succeeded') {
      for (const url of state.imageUrls) {
        if (!this.#finished.includes(url)) this.#finished.push(url);
      }
      this.#gallery.items = [...this.#finished];
      this.#gallery.selected = this.#shownUrl;
    }

    // The wallet moves on ANY terminal outcome — canceled/failed customComfy
    // runs still bill their elapsed GPU seconds.
    const terminal =
      state.phase === 'succeeded' || state.phase === 'failed' || state.phase === 'canceled';
    if (terminal && this.#lastPhase !== state.phase) void this.#refreshBalance();
    this.#lastPhase = state.phase;
  }

  async #pickCheckpoint(): Promise<void> {
    const selected = await this.session!.openCheckpointPicker({
      baseModelGroup: 'SDXL',
      ...(this.#checkpoint !== null && { currentVersionId: this.#checkpoint.versionId }),
    });
    if (!selected) return;
    this.#checkpoint = {
      modelId: selected.modelId,
      versionId: selected.versionId,
      name: `${selected.modelName} · ${selected.versionName}`,
    };
    this.#controls.checkpoint = { name: this.#checkpoint.name };
  }

  #onGenerate(request: PanoRequest): void {
    const session = this.session!;
    const snapshot = session.getSnapshot();
    if (!snapshot.viewer) {
      session.requestSignIn();
      return;
    }
    request.mode = this.#controls.mode;
    if (this.#checkpoint && (request.mode === 'seamless' || request.mode === 'hosted')) {
      request.checkpoint = { modelId: this.#checkpoint.modelId, versionId: this.#checkpoint.versionId };
    }
    if (!session.canGenerate()) {
      this.#consentPending = true;
      this.#pendingRequest = request;
      this.#status.state = { ...this.#controller!.getState(), phase: 'needs-consent' };
      session.requestConsent();
      return;
    }
    void this.#controller!.generate(request);
  }

  async #refreshBalance(): Promise<void> {
    const balance = await this.session!.getBuzzBalance();
    this.#renderBalance(balance);
  }

  #renderBalance(balance: BuzzBalance | null): void {
    if (!balance) {
      this.#balanceEl.style.display = 'none';
      return;
    }
    this.#balanceEl.style.display = '';
    this.#balanceEl.textContent = '';
    // Blue / Green / Yellow are Civitai's canonical Buzz-pool identity colors —
    // brand-fixed data colors (a pool's color is the same in light and dark),
    // NOT theme surface tokens, so they are intentionally literal here.
    const POOL_COLORS = { blue: '#4dabf7', green: '#51cf66', yellow: '#ffd43b' } as const;
    const pools: Array<{ label: string; value: number; color: string }> = [
      { label: 'Blue', value: balance.blue, color: POOL_COLORS.blue },
      { label: 'Green', value: balance.green, color: POOL_COLORS.green },
      { label: 'Yellow', value: balance.yellow, color: POOL_COLORS.yellow },
    ];
    for (const pool of pools) {
      const chip = document.createElement('span');
      chip.className = 'pn-pool';
      const dot = document.createElement('span');
      dot.className = 'pn-pool-dot';
      dot.style.background = pool.color;
      chip.append(dot, `${pool.label} ${formatCost(pool.value)}`);
      this.#balanceEl.appendChild(chip);
    }
    const total = document.createElement('span');
    total.className = 'pn-balance-total';
    total.textContent = `Total ${formatCost(balance.blue + balance.green + balance.yellow)} Buzz`;
    this.#balanceEl.appendChild(total);
  }
}
