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
  | { type: 'affect'; id: string; on: boolean; params?: AffectParams }
  /** A pointer or key event for committed affects that need it (Repeat: pointerdown, key B). */
  | { type: 'event'; name: 'down' | 'key'; code?: string };

export type FromWorker =
  /** The worker script loaded and is listening: safe to transfer the canvas to it. */
  | { type: 'alive' }
  | { type: 'ready' }
  /** A message or frame threw inside the host. The host stays alive with its log intact; the main thread only reports it. */
  | { type: 'error'; message: string }
  /** Repeat stamped a copy of a committed shape: a one-shape CommitBatch for the main thread to place in its affect range. */
  | { type: 'repeatClone'; buffer: ArrayBuffer }
  /** Repeat asks the main thread to commit the stamps it is holding. */
  | { type: 'repeatCommit' }
  /** The batch is drawn and presented; the main thread may drop its pending copy. */
  | { type: 'commitAck'; batchId: number };
