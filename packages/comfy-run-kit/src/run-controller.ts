// The run state machine: submit → poll to terminal, with the buzz ticker and
// (when the host provides a traceUrl) the trace tail feeding sampler progress,
// previews, logs, and tracebacks into one RunState stream. Framework-free —
// UIs subscribe() and render.

import { createBuzzMeter, type BuzzMeter } from './buzz-meter.js';
import { deriveRunPatch } from './derive.js';
import type { TraceEvent } from './trace/frame-decoder.js';
import { TraceTailer, type TraceTailerHandlers } from './trace/tailer.js';
import {
  INITIAL_RUN_STATE,
  TERMINAL_SNAPSHOT_STATUSES,
  type GatewayResult,
  type RunGateway,
  type RunState,
} from './types.js';

export const SCHEDULE_MS = [2000, 2000, 3000, 5000, 8000] as const;
export const RETRY_MS = [500, 1000, 2000, 4000] as const;
export const MAX_TRANSIENT_ERRORS = 8;
/** A poll that took at least this long was a long poll → re-poll immediately. */
export const LONG_POLL_THRESHOLD_MS = 1500;
export const LONG_POLL_REPOLL_MS = 250;
export const TICK_MS = 250;
export const LOG_CAP = 200;

export interface TraceTailerControl {
  start(): void;
  notifyTerminal(): void;
  stop(): void;
}

export type TraceTailerFactory = (
  url: string,
  handlers: TraceTailerHandlers,
) => TraceTailerControl;

export interface RunControllerOptions {
  gateway: RunGateway;
  /** Override (tests) or `null` to disable trace tailing entirely. */
  createTraceTailer?: TraceTailerFactory | null;
  /** Friendly names for trace `executing` node ids (graph-owner knowledge). */
  nodeLabels?: Record<string, string>;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

const defaultTailerFactory: TraceTailerFactory = (url, handlers) =>
  new TraceTailer({ url, ...handlers });

export class RunController {
  private state: RunState = { ...INITIAL_RUN_STATE };
  private readonly listeners = new Set<(state: RunState) => void>();
  private meter: BuzzMeter = createBuzzMeter();
  private pollToken: { cancelled: boolean } | null = null;
  private tailer: TraceTailerControl | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private userCanceled = false;
  private disposed = false;

  constructor(private readonly options: RunControllerOptions) {}

  getState(): RunState {
    return this.state;
  }

  subscribe(listener: (state: RunState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Submit and drive the run to terminal. Resolves once polling is underway. */
  async start(body: unknown): Promise<void> {
    this.abandonRun();
    this.userCanceled = false;
    this.meter = createBuzzMeter();
    this.set({ ...INITIAL_RUN_STATE, phase: 'submitting', startedAt: Date.now() });
    this.startTicker();

    let result: GatewayResult;
    try {
      result = await this.options.gateway.submit(body);
    } catch (err) {
      this.set({
        phase: 'failed',
        error: { message: err instanceof Error ? err.message : 'Submit failed.' },
      });
      this.stopTicker();
      return;
    }
    this.apply(result);
    if (TERMINAL_SNAPSHOT_STATUSES.has(result.snapshot.status)) return;
    if (result.snapshot.workflowId) this.runPollLoop(result.snapshot.workflowId);
  }

  /**
   * Real server-side stop: the orchestrator interrupts the render and post-paid
   * billing charges only the elapsed runtime. Sets the user-cancel flag FIRST —
   * a terminal `canceled` without it is inferred to be the orchestrator's
   * out-of-buzz auto-stop (wire-indistinguishable otherwise).
   */
  async cancel(): Promise<void> {
    const workflowId = this.state.workflowId;
    if (!workflowId || this.isTerminal() || this.state.cancelPending) return;
    this.userCanceled = true;
    this.set({ cancelPending: true });
    try {
      const result = await this.options.gateway.cancel(workflowId);
      this.apply(result);
      // A non-terminal reply means the host couldn't (or hasn't yet) canceled —
      // the poll loop keeps converging; leave the button usable again.
      if (!TERMINAL_SNAPSHOT_STATUSES.has(result.snapshot.status)) {
        this.set({ cancelPending: false });
      }
    } catch {
      this.set({ cancelPending: false });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abandonRun();
    this.listeners.clear();
  }

  private isTerminal(): boolean {
    return (
      this.state.phase === 'succeeded' ||
      this.state.phase === 'failed' ||
      this.state.phase === 'canceled'
    );
  }

  private abandonRun(): void {
    if (this.pollToken) this.pollToken.cancelled = true;
    this.stopTicker();
    this.tailer?.stop();
    this.tailer = null;
    if (this.state.previewUrl) {
      this.revoke(this.state.previewUrl);
      this.state = { ...this.state, previewUrl: null };
    }
  }

  private apply(result: GatewayResult): void {
    if (this.disposed) return;
    if (result.detail?.usage) this.meter.observeUsage(result.detail.usage);

    const patch = deriveRunPatch(this.state, result);

    if (result.detail?.traceUrl && !this.tailer && this.options.createTraceTailer !== null) {
      this.startTailer(result.detail.traceUrl);
    }

    const terminal = TERMINAL_SNAPSHOT_STATUSES.has(result.snapshot.status);
    if (terminal) {
      if (result.snapshot.status === 'canceled') {
        // Out-of-buzz needs ACCRUED billing, not just a pinned rate — a run the
        // orchestrator kills before it starts still reports a zero-cost usage
        // block, and that's not a balance problem.
        const accrued = this.meter.state(Date.now()).live ?? 0;
        patch.canceledReason = this.userCanceled ? 'user' : accrued > 0 ? 'outOfBuzz' : 'unknown';
      }
      this.meter.settle(patch.settled?.total);
      patch.cancelPending = false;
    }
    patch.buzz = this.meter.state(Date.now());
    this.set(patch);

    if (terminal) {
      this.stopTicker();
      if (this.pollToken) this.pollToken.cancelled = true;
      this.tailer?.notifyTerminal();
    }
  }

  private startTailer(url: string): void {
    const factory = this.options.createTraceTailer ?? defaultTailerFactory;
    this.tailer = factory(url, {
      onEvent: (event, ts) => this.onTraceEvent(event, ts),
      onPreview: (blob) => this.onPreview(blob),
    });
    this.tailer.start();
  }

  private onTraceEvent(event: TraceEvent, recordedTsMs?: number): void {
    if (this.disposed) return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    // The first execution frame IS the billing-clock start (verified: it lands
    // on usage.startedAt) — anchor the meter long before the server's first
    // runtime heartbeat would.
    if (
      event.type === 'execution_start' ||
      event.type === 'progress' ||
      (event.type === 'executing' && data.node != null)
    ) {
      this.meter.markComputeStart(recordedTsMs ?? Date.now());
    }
    switch (event.type) {
      case 'execution_start': {
        if (this.state.phase === 'starting' || this.state.phase === 'preparing') {
          this.set({ phase: 'running' });
        }
        break;
      }
      case 'progress': {
        const value = typeof data.value === 'number' ? data.value : null;
        const max = typeof data.max === 'number' ? data.max : null;
        if (value === null || max === null || max <= 0) break;
        const patch: Partial<RunState> = {
          sampler: { step: value, total: max, pct: Math.min(100, Math.round((value / max) * 100)) },
        };
        if (this.state.phase === 'starting' || this.state.phase === 'preparing') {
          patch.phase = 'running';
        }
        this.set(patch);
        break;
      }
      case 'executing': {
        const node = typeof data.node === 'string' ? data.node : null;
        const patch: Partial<RunState> = {
          currentNode: node === null ? null : (this.options.nodeLabels?.[node] ?? node),
        };
        if (node !== null && (this.state.phase === 'starting' || this.state.phase === 'preparing')) {
          patch.phase = 'running';
        }
        this.set(patch);
        break;
      }
      case 'logs': {
        const entries = Array.isArray(data.entries) ? data.entries : [];
        const lines = entries
          .map((e) =>
            e && typeof e === 'object' && typeof (e as { m?: unknown }).m === 'string'
              ? (e as { m: string }).m
              : String(e),
          )
          // Worker console lines carry ANSI color escapes — garbage in a <pre>.
          .map((line) => line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+$/, ''))
          .filter((line) => line.length > 0);
        if (lines.length > 0) {
          this.set({ logs: [...this.state.logs, ...lines].slice(-LOG_CAP) });
        }
        break;
      }
      case 'execution_error': {
        const message =
          typeof data.exception_message === 'string' ? data.exception_message : 'Execution error.';
        const traceback = Array.isArray(data.traceback) ? data.traceback.join('') : undefined;
        this.set({ error: { message, ...(traceback !== undefined && { traceback }) } });
        break;
      }
      default:
        break;
    }
  }

  private onPreview(blob: Blob): void {
    if (this.disposed) return;
    const create = this.options.createObjectUrl ?? ((b: Blob) => URL.createObjectURL(b));
    const url = create(blob);
    const previous = this.state.previewUrl;
    this.set({ previewUrl: url });
    if (previous) this.revoke(previous);
  }

  private revoke(url: string): void {
    (this.options.revokeObjectUrl ?? ((u: string) => URL.revokeObjectURL(u)))(url);
  }

  private runPollLoop(workflowId: string): void {
    const token = { cancelled: false };
    this.pollToken = token;
    let attempt = 0;
    let consecutiveErrors = 0;

    const tick = async () => {
      if (token.cancelled) return;
      const t0 = Date.now();
      let result: GatewayResult;
      try {
        result = await this.options.gateway.poll(workflowId);
      } catch {
        if (token.cancelled) return;
        consecutiveErrors += 1;
        if (consecutiveErrors > MAX_TRANSIENT_ERRORS) {
          this.set({
            phase: 'failed',
            error: {
              message:
                "Couldn't reach the generation service after several retries. " +
                'The run may still be in progress.',
            },
          });
          this.stopTicker();
          return;
        }
        setTimeout(tick, RETRY_MS[Math.min(consecutiveErrors - 1, RETRY_MS.length - 1)]);
        return;
      }
      if (token.cancelled) return;
      consecutiveErrors = 0;
      this.apply(result);
      if (TERMINAL_SNAPSHOT_STATUSES.has(result.snapshot.status)) return;
      const took = Date.now() - t0;
      const delay =
        took >= LONG_POLL_THRESHOLD_MS
          ? LONG_POLL_REPOLL_MS
          : SCHEDULE_MS[Math.min(attempt, SCHEDULE_MS.length - 1)];
      attempt += 1;
      setTimeout(tick, delay);
    };

    setTimeout(tick, 0);
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = setInterval(() => {
      const now = Date.now();
      this.set({
        elapsedSeconds: this.state.startedAt ? Math.floor((now - this.state.startedAt) / 1000) : 0,
        buzz: this.meter.state(now),
      });
    }, TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private set(patch: Partial<RunState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
