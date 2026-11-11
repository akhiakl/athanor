// Minimal canvas page: pointer capture -> InputRing -> Engine -> RenderClient -> (render worker | local host).
// shortcut: dev-only keys (1-5 select module, C clears) until the real shortcut map and HUD land (step 4).
import { InputRing, KIND_MOUSE, KIND_PEN, KIND_TOUCH, META_COALESCED, META_HW_PRESSURE, PHASE_CANCEL, PHASE_DOWN, PHASE_MOVE, PHASE_UP, packMeta } from '../core/inputRing';
import { Engine } from '../engine/engine';
import { repeatStamps } from '../modules/affect/repeatStamps';
import { affectModules, createModules } from '../modules/registry';
import { ActiveRenderer } from '../render/active';
import { RenderClient } from '../render/client';
import { effectiveDpr } from '../render/dpr';
import { RenderHost } from '../render/host';
import type { FromWorker } from '../render/protocol';
import { Transport } from '../render/transport';

const stage = document.getElementById('stage') as HTMLElement;
let committedCanvas = document.getElementById('committed') as HTMLCanvasElement;
const activeCanvas = document.getElementById('active') as HTMLCanvasElement;
const activeCtx = activeCanvas.getContext('2d', { alpha: true, desynchronized: true })!;

const urlSeed = new URLSearchParams(location.search).get('seed');
const seed = urlSeed !== null ? Number(urlSeed) | 0 : crypto.getRandomValues(new Uint32Array(1))[0];

let scheduled = false; // declared before createBackend: the local host requests a frame during init

/**
 * Worker when OffscreenCanvas transfer exists (spec 2.6); otherwise, or if the worker fails to start, the same RenderHost runs on
 * the main thread. The canvas is transferred only after the worker answers 'alive', so a worker that cannot load leaves the canvas
 * usable. ?worker=0 forces local. In dev, ?worker=broken points the worker at a missing script to exercise the fallback.
 */
function createBackend(): { client: RenderClient; frame: () => boolean } {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const dpr = effectiveDpr(w, h, window.devicePixelRatio);
  const mode = new URLSearchParams(location.search).get('worker');
  const transport = new Transport();
  const client = new RenderClient(transport.send, true, () => request());
  let host: RenderHost | null = null;
  let transferred = false;
  let settled = false;

  const startLocal = (reason: string): void => {
    if (settled && host) return;
    settled = true;
    if (reason) console.warn(`render worker unavailable (${reason}); using the main-thread renderer`);
    if (transferred) {
      // a transferred canvas cannot be drawn on again: swap in a fresh element (strokes held by the dead worker are lost)
      const fresh = document.createElement('canvas');
      committedCanvas.replaceWith(fresh);
      committedCanvas = fresh;
      client.dropPending();
    }
    client.transfer = false; // the local host never detaches buffers, so skip the defensive copy
    const local = new RenderHost((m) => client.onMessage(m), () => request(), { budgetMs: 2, ackImmediately: true });
    host = local;
    local.handle({ type: 'init', canvas: committedCanvas as unknown as OffscreenCanvas, dpr, w, h, seed });
    transport.attach((m) => local.handle(m));
  };

  if (mode !== '0' && typeof Worker !== 'undefined' && 'transferControlToOffscreen' in committedCanvas) {
    // Both Worker constructions must stay literal: Vite only bundles the worker script when it sees `new Worker(new URL(...))`.
    const worker = import.meta.env.DEV && mode === 'broken'
      ? new Worker('/render-worker-missing.js', { type: 'module' })
      : new Worker(new URL('../render/worker.ts', import.meta.url), { type: 'module' });
    const fail = (reason: string): void => {
      if (host) return;
      worker.terminate();
      startLocal(reason);
    };
    worker.onerror = (e) => fail(e.message || 'worker error');
    worker.onmessageerror = () => fail('message error');
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.type !== 'alive') return client.onMessage(e.data);
      if (settled || host) return;
      settled = true;
      const canvas = committedCanvas.transferControlToOffscreen();
      transferred = true;
      worker.postMessage({ type: 'init', canvas, dpr, w, h, seed }, [canvas]);
      transport.attach((m, t) => worker.postMessage(m, t ?? []));
    };
    setTimeout(() => {
      if (!settled) fail('no response in 5 s');
    }, 5000);
  } else {
    startLocal('');
  }
  return { client, frame: () => (host ? host.frame() : false) }; // a worker drives its own replay
}

const { client, frame: backendFrame } = createBackend();
const engine = new Engine(seed, client);
engine.view.w = stage.clientWidth;
engine.view.h = stage.clientHeight;

// Repeat's stamps come back from the worker and wait in the main thread's affect range until placed.
const stamps = repeatStamps();
client.onRepeatClone = (shape) => {
  if (engine.hasAffect(stamps.id)) stamps.add(engine, shape);
  request();
};
client.onRepeatCommit = () => {
  if (engine.hasAffect(stamps.id)) stamps.place(engine);
  request();
};
const ring = new InputRing();
const active = new ActiveRenderer();
const epoch = performance.now();
let down = false;
let originX = 0; // cached stage offset: reading layout per coalesced event would force reflow in a hot loop
let originY = 0;

function measure(): void {
  const r = stage.getBoundingClientRect();
  originX = r.left;
  originY = r.top;
}

engine.select(createModules[0].make());

function resize(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  measure();
  const dpr = effectiveDpr(w, h, window.devicePixelRatio);
  activeCanvas.width = Math.round(w * dpr);
  activeCanvas.height = Math.round(h * dpr);
  activeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  engine.view.w = w;
  engine.view.h = h;
  client.resize(w, h, dpr); // the committed canvas belongs to the backend
  request();
}

function request(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(frame);
}

function frame(): void {
  scheduled = false;
  engine.tick(ring);
  client.tick(engine.createCount);
  // Blindness hides both layers while drawing (5.4.10); the drawing still commits underneath.
  const visibility = engine.flags.blind ? 'hidden' : 'visible';
  activeCanvas.style.visibility = committedCanvas.style.visibility = visibility;
  if (!engine.flags.blind) active.render(activeCtx, engine, client.pending);
  const more = backendFrame(); // local mode replays dirty tiles here; the worker does its own
  if (down || more) request(); // idle when no stroke is active (2.3 step 7)
}

function write(ev: PointerEvent, phase: number, extra = 0): void {
  const kind = ev.pointerType === 'pen' ? KIND_PEN : ev.pointerType === 'touch' ? KIND_TOUCH : KIND_MOUSE;
  // Hardware pressure: pens always (even a reported 0 at pointerdown); touch only when it reports something other than the 0.5 default.
  const hw = kind === KIND_PEN || (kind === KIND_TOUCH && ev.pressure > 0 && ev.pressure !== 0.5);
  ring.write(ev.clientX - originX, ev.clientY - originY, ev.timeStamp - epoch, ev.pressure, ev.tiltX, ev.tiltY, ev.buttons,
    packMeta(kind, phase, extra | (hw ? META_HW_PRESSURE : 0)));
}

stage.addEventListener('pointerdown', (ev) => {
  if (!ev.isPrimary || ev.button !== 0) return;
  stage.setPointerCapture(ev.pointerId);
  measure(); // once per stroke, covers scroll/layout shifts
  down = true;
  write(ev, PHASE_DOWN);
  client.event('down');
  request();
});
stage.addEventListener('pointermove', (ev) => {
  if (!ev.isPrimary) return;
  if (!down) {
    // hover (buttons 0) feeds the committed-domain affects directly
    if (client.hasAffects) {
      client.hover(ev.clientX - originX, ev.clientY - originY, ev.timeStamp - epoch);
      request();
    }
    return;
  }
  const list = ev.getCoalescedEvents?.() ?? [];
  if (list.length > 1) for (const c of list) write(c, PHASE_MOVE, META_COALESCED);
  else write(ev, PHASE_MOVE);
  request();
}, { passive: true });
const end = (phase: number) => (ev: PointerEvent) => {
  if (!down || !ev.isPrimary) return;
  down = false;
  write(ev, phase);
  request();
};
stage.addEventListener('pointerup', end(PHASE_UP));
stage.addEventListener('pointercancel', end(PHASE_CANCEL));

// Dev-only keys until the HUD and the real shortcut map land (step 4): 1-5 create module, C clear,
// committed affects Q random, W smooth, E limit, T repeat; active affects A displace, S gradient, D mirror, F colour switcher, G blindness.
// R (Blindness reveal) and B (Repeat toggle) are the spec's own keys and are forwarded to the modules.
const committedKeys: Record<string, string | undefined> = { q: 'affect.random', w: 'affect.smooth', e: 'affect.limit', t: 'affect.repeat' };
const activeKeys: Record<string, string | undefined> = { a: 'affect.displace', s: 'affect.gradient', d: 'affect.mirror', f: 'affect.colorSwitcher', g: 'affect.blindness' };

function toggleCommitted(id: string): void {
  const on = !client.isAffectOn(id);
  if (id === 'affect.repeat') {
    if (on) engine.addAffect(stamps);
    else {
      stamps.place(engine); // keep what was stamped
      engine.removeAffect(stamps.id);
    }
  }
  client.setAffect(id, on);
}

function toggleActive(id: string): void {
  if (engine.hasAffect(id)) engine.removeAffect(id);
  else engine.addAffect(affectModules.find((d) => d.id === id)!.make());
}

window.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return; // OS auto-repeat would flip toggles at random
  const k = ev.key.toLowerCase();
  if (!down) {
    const n = Number(ev.key);
    if (n >= 1 && n <= createModules.length) engine.select(createModules[n - 1].make());
    else if (k === 'c') client.clear();
    else if (committedKeys[k]) toggleCommitted(committedKeys[k]!);
    else if (activeKeys[k]) toggleActive(activeKeys[k]!);
  }
  engine.key(ev.code, ev.key); // Blindness reveal (R)
  client.event('key', ev.code); // Repeat toggle (B)
  request();
});

new ResizeObserver(resize).observe(stage);
resize();

if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__athanor = { engine, client, ring };
