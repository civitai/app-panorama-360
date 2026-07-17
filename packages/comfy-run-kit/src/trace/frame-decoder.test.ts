import { describe, expect, it } from 'vitest';

import { TraceFrameDecoder, type TraceFrame } from './frame-decoder.js';

function frame(opcode: number, payload: Uint8Array, ts = 1_700_000_000_000n): Uint8Array {
  const buf = new Uint8Array(14 + payload.length);
  const view = new DataView(buf.buffer);
  view.setBigInt64(0, ts, false);
  buf[8] = 0;
  buf[9] = opcode;
  view.setUint32(10, payload.length, false);
  buf.set(payload, 14);
  return buf;
}

const textPayload = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
const concat = (...parts: Uint8Array[]) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

describe('TraceFrameDecoder', () => {
  it('decodes a single text frame with timestamp and event', () => {
    const decoder = new TraceFrameDecoder();
    const frames = decoder.push(frame(1, textPayload({ type: 'progress', data: { value: 3, max: 30 } })));
    expect(frames).toHaveLength(1);
    const f = frames[0];
    expect(f.ts).toBe(1_700_000_000_000);
    expect(f.opcode).toBe(1);
    if (f.opcode === 1) expect(f.event).toEqual({ type: 'progress', data: { value: 3, max: 30 } });
  });

  it('decodes back-to-back frames in one chunk', () => {
    const decoder = new TraceFrameDecoder();
    const stream = concat(
      frame(1, textPayload({ type: 'executing', data: { node: '7' } })),
      frame(1, textPayload({ type: 'progress', data: { value: 1, max: 30 } })),
    );
    const frames = decoder.push(stream);
    expect(frames.map((f) => (f.opcode === 1 ? f.event.type : 'preview'))).toEqual([
      'executing',
      'progress',
    ]);
  });

  it('carries partial frames across pushes — split at every byte boundary', () => {
    const stream = concat(
      frame(1, textPayload({ type: 'executing', data: { node: '7' } })),
      frame(2, PNG_BYTES),
      frame(1, textPayload({ type: 'progress', data: { value: 2, max: 30 } })),
    );
    for (let split = 1; split < stream.length; split++) {
      const decoder = new TraceFrameDecoder();
      const frames: TraceFrame[] = [
        ...decoder.push(stream.subarray(0, split)),
        ...decoder.push(stream.subarray(split)),
      ];
      expect(frames).toHaveLength(3);
      expect(frames[1].opcode).toBe(2);
    }
  });

  it('sniffs preview image formats from the payload magic', () => {
    const decoder = new TraceFrameDecoder();
    const frames = decoder.push(concat(frame(2, PNG_BYTES), frame(2, JPEG_BYTES)));
    expect(frames).toHaveLength(2);
    expect(frames[0].opcode === 2 && frames[0].mimeType).toBe('image/png');
    expect(frames[1].opcode === 2 && frames[1].mimeType).toBe('image/jpeg');
    if (frames[0].opcode === 2) expect([...frames[0].imageBytes]).toEqual([...PNG_BYTES]);
  });

  it('skips unknown opcodes and malformed JSON without losing alignment', () => {
    const decoder = new TraceFrameDecoder();
    const frames = decoder.push(
      concat(
        frame(9, new Uint8Array([1, 2, 3])),
        frame(1, new TextEncoder().encode('{not json')),
        frame(1, textPayload({ type: 'logs', data: { entries: [] } })),
      ),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].opcode === 1 && frames[0].event.type).toBe('logs');
  });
});
