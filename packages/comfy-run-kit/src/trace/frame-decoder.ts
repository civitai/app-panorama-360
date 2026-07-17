// Incremental decoder for the orchestrator's binary trace blob (`trace:
// "binary"` on a customComfy submit): the worker's real ComfyUI /ws session,
// recorded as repeating frames
//   [timestamp: 8B BE int64 ms][direction: 1B][opcode: 1B][length: 4B BE u32][payload]
// opcode 1 = UTF-8 JSON ws frame {type, data}; opcode 2 = a preview image whose
// 8-byte ComfyUI preview header was stripped at record time (raw PNG/JPEG
// bytes). Frames split across network chunks, so the decoder carries the
// partial tail between push() calls.

const HEADER_BYTES = 14;

export interface TraceEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface TraceTextFrame {
  ts: number;
  opcode: 1;
  event: TraceEvent;
}

export interface TracePreviewFrame {
  ts: number;
  opcode: 2;
  imageBytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
}

export type TraceFrame = TraceTextFrame | TracePreviewFrame;

/** The header's format field is gone (stripped with it) — sniff the magic. */
function sniffMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/png';
}

export class TraceFrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly textDecoder = new TextDecoder();

  push(chunk: Uint8Array): TraceFrame[] {
    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }

    const frames: TraceFrame[] = [];
    let offset = 0;
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);

    while (this.buffer.length - offset >= HEADER_BYTES) {
      const length = view.getUint32(offset + 10, false);
      if (this.buffer.length - offset < HEADER_BYTES + length) break;

      const ts = Number(view.getBigInt64(offset, false));
      const opcode = this.buffer[offset + 9];
      const payload = this.buffer.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length);
      offset += HEADER_BYTES + length;

      if (opcode === 1) {
        try {
          const event = JSON.parse(this.textDecoder.decode(payload)) as TraceEvent;
          if (event && typeof event.type === 'string') {
            frames.push({ ts, opcode: 1, event });
          }
        } catch {
          // A malformed text frame is dropped; the stream stays aligned.
        }
      } else if (opcode === 2) {
        const imageBytes = payload.slice();
        frames.push({ ts, opcode: 2, imageBytes, mimeType: sniffMime(imageBytes) });
      }
      // Unknown opcodes are skipped (length-prefixed, so alignment holds).
    }

    this.buffer = offset > 0 ? this.buffer.slice(offset) : this.buffer;
    return frames;
  }
}
