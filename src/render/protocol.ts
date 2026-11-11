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
  /** Undo history: a pointer gesture opens and closes a group (8.5.2); undo and redo act on the newest group. */
  /** Serialize the committed log. The result comes back as `exportResult` with the same id. */
  | { type: 'export'; id: number; format: 'png' | 'svg' | 'pdf'; scale: number; transparent: boolean }
  /** Open a page of the document (loading its saved drawing) or flush pending saves now. */
  | { type: 'page'; op: 'open'; pageId: string; width: number; height: number; background: number }
  | { type: 'page'; op: 'flush'; id: number }
  | { type: 'history'; op: 'begin' | 'end' | 'undo' | 'redo' }
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
  | { type: 'exportResult'; id: number; blob: Blob }
  | { type: 'exportError'; id: number; message: string }
  /** Page lifecycle and autosave status. `opened` answers a page open; the rest report saving. */
  | { type: 'pageState'; state: 'opened' | 'saving' | 'saved' | 'error'; pageId?: string; empty?: boolean; message?: string }
  /** Answers a `page flush`: everything queued before it is written (or failed, see `error`). */
  | { type: 'pageFlushed'; id: number; error?: string; /** changes since the page opened; equal readings mean no change between them */ revision: number }
  /** What undo and redo can do now, sent when it changes. */
  | { type: 'historyState'; canUndo: boolean; canRedo: boolean }
  /** The batch is drawn and presented; the main thread may drop its pending copy. */
  | { type: 'commitAck'; batchId: number };
