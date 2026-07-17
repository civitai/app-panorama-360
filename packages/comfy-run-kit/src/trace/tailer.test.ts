import { describe, expect, it, vi } from 'vitest';

import { TraceTailer } from './tailer.js';
import type { TraceEvent } from './frame-decoder.js';

function frame(opcode: number, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(14 + payload.length);
  const view = new DataView(buf.buffer);
  view.setBigInt64(0, 1n, false);
  buf[9] = opcode;
  view.setUint32(10, payload.length, false);
  buf.set(payload, 14);
  return buf;
}

const textFrame = (obj: unknown) => frame(1, new TextEncoder().encode(JSON.stringify(obj)));

function streamResponse(chunks: Uint8Array[], opts: { errorAtEnd?: boolean } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (opts.errorAtEnd) controller.error(new Error('connection reset'));
      else controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

function notFoundResponse(): Response {
  return { ok: false, status: 404, body: null } as unknown as Response;
}

function hangingResponse(signal: AbortSignal | undefined, chunks: Uint8Array[] = []): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      signal?.addEventListener('abort', () => {
        try {
          controller.error(new Error('aborted'));
        } catch {
          // already closed
        }
      });
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const FAST = { initialRetryMs: 1, maxRetryMs: 2 };

describe('TraceTailer', () => {
  it('retries through the 404-before-first-byte window, then streams', async () => {
    const events: TraceEvent[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(streamResponse([textFrame({ type: 'progress', data: { value: 1, max: 30 } })]));
    const ended = vi.fn();
    const tailer = new TraceTailer({
      url: '/trace',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent: (e) => events.push(e),
      onEnd: ended,
      ...FAST,
    });
    tailer.start();
    await vi.waitFor(() => expect(ended).toHaveBeenCalled());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(events.map((e) => e.type)).toEqual(['progress']);
  });

  it('treats a clean stream end as complete — never reconnects', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(streamResponse([textFrame({ type: 'executing', data: { node: '1' } })]));
    const ended = vi.fn();
    const tailer = new TraceTailer({
      url: '/trace',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEnd: ended,
      ...FAST,
    });
    tailer.start();
    await vi.waitFor(() => expect(ended).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reconnects after an abnormal break, skipping already-decoded bytes', async () => {
    const f1 = textFrame({ type: 'progress', data: { value: 1, max: 2 } });
    const f2 = textFrame({ type: 'progress', data: { value: 2, max: 2 } });
    const events: TraceEvent[] = [];
    const fetchImpl = vi
      .fn()
      // First connection delivers f1 then dies mid-stream.
      .mockResolvedValueOnce(streamResponse([f1], { errorAtEnd: true }))
      // Reconnect replays the WHOLE blob from byte 0 — f1 must not re-emit.
      .mockResolvedValueOnce(streamResponse([f1, f2]));
    const ended = vi.fn();
    const tailer = new TraceTailer({
      url: '/trace',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent: (e) => events.push(e),
      onEnd: ended,
      ...FAST,
    });
    tailer.start();
    await vi.waitFor(() => expect(ended).toHaveBeenCalled());
    expect(events.map((e) => (e.data as { value: number }).value)).toEqual([1, 2]);
  });

  it('notifyTerminal stops an unfinished tail after the grace window', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(hangingResponse(init?.signal ?? undefined)),
    );
    const ended = vi.fn();
    const tailer = new TraceTailer({
      url: '/trace',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEnd: ended,
      terminalGraceMs: 5,
      ...FAST,
    });
    tailer.start();
    await new Promise((r) => setTimeout(r, 5));
    tailer.notifyTerminal();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
  });

  it('filters events to the forwarded allowlist and emits previews as blobs', async () => {
    const events: TraceEvent[] = [];
    const previews: Blob[] = [];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const fetchImpl = vi.fn().mockResolvedValue(
      streamResponse([
        textFrame({ type: 'status', data: { exec_info: { queue_remaining: 4 } } }),
        textFrame({ type: 'logs', data: { entries: [{ t: 'x', m: 'hello' }] } }),
        frame(2, png),
      ]),
    );
    const ended = vi.fn();
    const tailer = new TraceTailer({
      url: '/trace',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent: (e) => events.push(e),
      onPreview: (b) => previews.push(b),
      onEnd: ended,
      ...FAST,
    });
    tailer.start();
    await vi.waitFor(() => expect(ended).toHaveBeenCalled());
    expect(events.map((e) => e.type)).toEqual(['logs']);
    expect(previews).toHaveLength(1);
    expect(previews[0].type).toBe('image/png');
  });

  it('stop() aborts an in-flight connection', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(hangingResponse(init?.signal ?? undefined)),
    );
    const ended = vi.fn();
    const tailer = new TraceTailer({
      url: '/trace',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEnd: ended,
      ...FAST,
    });
    tailer.start();
    await new Promise((r) => setTimeout(r, 5));
    tailer.stop();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
  });
});
