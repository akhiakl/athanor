// Render worker shell: forwards messages to RenderHost and drives its frames from the worker's own rAF.
/// <reference lib="webworker" />
import { RenderHost } from './host';
import type { ToWorker } from './protocol';

const raf: (cb: () => void) => void = 'requestAnimationFrame' in self ? (cb) => self.requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16);
let scheduled = false;

function requestFrame(): void {
  if (scheduled) return;
  scheduled = true;
  raf(() => {
    scheduled = false;
    if (host.frame()) requestFrame();
  });
}

const host = new RenderHost((m, t) => self.postMessage(m, t ?? []), requestFrame, { budgetMs: 4 });
self.onmessage = (e: MessageEvent<ToWorker>) => host.handle(e.data);
self.postMessage({ type: 'alive' }); // handshake: the main thread transfers the canvas only after this
