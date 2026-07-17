// Tails the trace blob over plain HTTP (it's anonymously GETtable) and emits
// decoded ComfyUI events + preview blobs. Semantics proven by the comfy-nodes
// offload tailer:
//  - the blob 404s until the worker writes its first byte → patient retry,
//    0.5s doubling to 5s;
//  - a CLEAN stream end means the recording is complete → never reconnect
//    (a fresh GET replays the whole blob from byte 0 and would double-emit);
//  - an ABNORMAL break reconnects, skipping the bytes already decoded;
//  - after the workflow goes terminal, keep reading ~10s for the tail frames.

import {
  TraceFrameDecoder,
  type TraceEvent,
  type TraceFrame,
} from './frame-decoder.js';

/** ComfyUI ws event types worth surfacing; everything else is protocol noise. */
export const FORWARDED_TRACE_EVENTS: ReadonlySet<string> = new Set([
  'execution_start',
  'executing',
  'executed',
  'progress',
  'progress_state',
  'execution_success',
  'execution_error',
  'execution_interrupted',
  'execution_cached',
  'logs',
]);

export interface TraceTailerHandlers {
  /** `recordedTsMs` is the frame's server-clock timestamp from the wire header. */
  onEvent?: (event: TraceEvent, recordedTsMs?: number) => void;
  onPreview?: (blob: Blob) => void;
  /** Fires once, when tailing stops for any reason. */
  onEnd?: () => void;
}

export interface TraceTailerOptions extends TraceTailerHandlers {
  url: string;
  fetchImpl?: typeof fetch;
  terminalGraceMs?: number;
  initialRetryMs?: number;
  maxRetryMs?: number;
}

export class TraceTailer {
  private started = false;
  private stopped = false;
  private ended = false;
  private abortController: AbortController | null = null;
  private graceHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: TraceTailerOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.run();
  }

  /** The workflow reached a terminal status — finish the tail, then stop. */
  notifyTerminal(): void {
    if (this.stopped || this.graceHandle !== null) return;
    this.graceHandle = setTimeout(() => this.stop(), this.options.terminalGraceMs ?? 10_000);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.graceHandle !== null) {
      clearTimeout(this.graceHandle);
      this.graceHandle = null;
    }
    this.abortController?.abort();
    if (!this.started) this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.graceHandle !== null) {
      clearTimeout(this.graceHandle);
      this.graceHandle = null;
    }
    this.options.onEnd?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private dispatch(frames: TraceFrame[]): void {
    for (const frame of frames) {
      if (frame.opcode === 1) {
        if (FORWARDED_TRACE_EVENTS.has(frame.event.type)) {
          this.options.onEvent?.(frame.event, frame.ts);
        }
      } else {
        this.options.onPreview?.(new Blob([frame.imageBytes as BlobPart], { type: frame.mimeType }));
      }
    }
  }

  private async run(): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const initialRetryMs = this.options.initialRetryMs ?? 500;
    const maxRetryMs = this.options.maxRetryMs ?? 5_000;
    const decoder = new TraceFrameDecoder();
    let retryMs = initialRetryMs;
    let bytesConsumed = 0;

    while (!this.stopped) {
      this.abortController = new AbortController();
      let response: Response;
      try {
        response = await fetchImpl(this.options.url, { signal: this.abortController.signal });
      } catch {
        if (this.stopped) break;
        await this.sleep(retryMs);
        retryMs = Math.min(retryMs * 2, maxRetryMs);
        continue;
      }

      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        if (this.stopped) break;
        await this.sleep(retryMs);
        retryMs = Math.min(retryMs * 2, maxRetryMs);
        continue;
      }

      retryMs = initialRetryMs;
      const reader = response.body.getReader();
      let toSkip = bytesConsumed;
      let cleanEnd = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            cleanEnd = true;
            break;
          }
          if (!value || value.length === 0) continue;
          let chunk: Uint8Array = value;
          if (toSkip > 0) {
            if (chunk.length <= toSkip) {
              toSkip -= chunk.length;
              continue;
            }
            chunk = chunk.subarray(toSkip);
            toSkip = 0;
          }
          bytesConsumed += chunk.length;
          this.dispatch(decoder.push(chunk));
        }
      } catch {
        // Abnormal break — reconnect below (offset-skipped) unless stopped.
      }

      if (cleanEnd || this.stopped) break;
      await this.sleep(retryMs);
      retryMs = Math.min(retryMs * 2, maxRetryMs);
    }

    this.stopped = true;
    this.finish();
  }
}
