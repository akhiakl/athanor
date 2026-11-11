// Main <-> render worker messages, spec 3.2.4. Only typed arrays and ArrayBuffers cross; buffers are transferred.
import type { AffectParams } from './affects';

export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas; dpr: number; w: number; h: number; seed: number }
  | { type: 'commit'; batchId: number; buffer: ArrayBuffer }
  /** x, y, t triplets, at most 64 per message (7.2). */
  | { type: 'hover'; samples: Float32Array }
  | { type: 'tick'; activeCount: number }
  | { type: 'resize'; dpr: number; w: number; h: number }
  | { type: 'clear' }
  | { type: 'affect'; id: string; on: boolean; params?: AffectParams };

export type FromWorker =
  | { type: 'ready' }
  /** The batch is drawn and presented; the main thread may drop its pending copy. */
  | { type: 'commitAck'; batchId: number };
