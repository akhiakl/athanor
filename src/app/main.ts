// Minimal canvas page: pointer capture -> InputRing -> Engine -> RenderClient -> (render worker | local host).
import { InputRing, KIND_MOUSE, KIND_PEN, KIND_TOUCH, META_COALESCED, META_HW_PRESSURE, PHASE_CANCEL, PHASE_DOWN, PHASE_MOVE, PHASE_UP, packMeta } from '../core/inputRing';
import { effect } from '@preact/signals';
import { idiv } from '../core/math';
import { createHud } from '../hud/hud';
import { mountHud } from '../hud/mount';
import { Engine } from '../engine/engine';
import { repeatStamps } from '../modules/affect/repeatStamps';
import { ActiveRenderer } from '../render/active';
import { RenderClient } from '../render/client';
import { effectiveDpr } from '../render/dpr';
import { RenderHost } from '../render/host';
import type { FromWorker } from '../render/protocol';
import { Transport } from '../render/transport';
import { createApp } from './app';
import { isMac, isTextEntry, matchShortcut } from './shortcuts';
import { lockViewport } from './viewport';

const stage = document.getElementById('stage') as HTMLElement;
let committedCanvas = document.getElementById('committed') as HTMLCanvasElement;
const activeCanvas = document.getElementById('active') as HTMLCanvasElement;
const activeCtx = activeCanvas.getContext('2d', { alpha: true, desynchronized: true })!;
const guidesCanvas = document.getElementById('guides') as HTMLCanvasElement;
const guidesCtx = guidesCanvas.getContext('2d')!;
lockViewport(stage);

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
let axisDrag = false;
let originX = 0; // cached stage offset: reading layout per coalesced event would force reflow in a hot loop
let originY = 0;

function measure(): void {
  const r = stage.getBoundingClientRect();
  originX = r.left;
  originY = r.top;
}

const hud = createHud();
const app = createApp(engine, client, stamps, { redraw: () => request() });
mountHud(document.getElementById('hud')!, app, hud);
effect(() => void (stage.style.cursor = app.cursorHidden.value ? 'none' : 'crosshair'));

// Mirror's axis-move mode shows a crosshair on the guide layer; redrawn only when the axes or the mode change.
function drawGuides(): void {
  const w = engine.view.w, h = engine.view.h;
  guidesCtx.clearRect(0, 0, w, h);
  if (!app.axisMove.value) return;
  let [ax, by] = app.mirrorAxis() ?? [NaN, NaN];
  if (Number.isNaN(ax)) {
    ax = idiv(w, 2);
    by = idiv(h, 2);
  }
  guidesCtx.strokeStyle = '#1d70b8';
  guidesCtx.lineWidth = 1;
  guidesCtx.setLineDash([6, 4]);
  guidesCtx.beginPath();
  guidesCtx.moveTo(ax + 0.5, 0); guidesCtx.lineTo(ax + 0.5, h);
  guidesCtx.moveTo(0, by + 0.5); guidesCtx.lineTo(w, by + 0.5);
  guidesCtx.stroke();
}
effect(() => {
  void app.axisMove.value;
  drawGuides();
});

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
  guidesCanvas.width = Math.round(w * dpr);
  guidesCanvas.height = Math.round(h * dpr);
  guidesCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawGuides();
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
  if (app.axisMove.value) {
    axisDrag = true;
    app.moveAxis(ev.clientX - originX, ev.clientY - originY);
    drawGuides();
    return;
  }
  if (ev.pointerType === 'pen') app.setSlot(ev.buttons & 32 ? 1 : 0); // eraser end selects colour slot 1 (F2)
  hud.strokeStart();
  down = true;
  write(ev, PHASE_DOWN);
  client.event('down');
  request();
});
stage.addEventListener('pointermove', (ev) => {
  if (!ev.isPrimary) return;
  if (axisDrag) {
    app.moveAxis(ev.clientX - originX, ev.clientY - originY);
    drawGuides();
    return;
  }
  if (!down) {
    if (hud.mode.value === 'proximity') hud.move(ev.clientY);
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
  if (axisDrag && ev.isPrimary) {
    axisDrag = false;
    app.axisMove.value = false; // one placement per use of "Move axis"
    return;
  }
  if (!down || !ev.isPrimary) return;
  down = false;
  hud.strokeEnd();
  write(ev, phase);
  request();
};
stage.addEventListener('pointerup', end(PHASE_UP));
stage.addEventListener('pointercancel', end(PHASE_CANCEL));
stage.addEventListener('lostpointercapture', end(PHASE_CANCEL)); // capture lost mid-stroke = commit (6.4)

const mac = isMac();

window.addEventListener('keydown', (ev) => {
  if (isTextEntry(ev.target as HTMLElement | null)) return;
  const mod = mac ? ev.metaKey : ev.ctrlKey;
  const a = matchShortcut(ev.code, { mod, shift: ev.shiftKey, alt: ev.altKey });
  if (a) {
    // Tab and Space keep their native meaning (focus traversal, button activation) inside the HUD
    const onCanvas = ev.target === document.body || ev.target === stage;
    if ((a.t === 'hudFlip' || a.t === 'hudToggle') && !onCanvas) return;
    if (ev.repeat && a.t !== 'width' && a.t !== 'alpha') return; // auto-repeat would flip toggles at random
    ev.preventDefault();
    if (down) return; // module and style changes wait for the stroke to end
    if (hud.mode.value === 'floating') {
      // Tab toggles the swatches panel, Space and Mod+. collapse the pill to a dot and back
      if (a.t === 'hudFlip') hud.swatchPanel.value = !hud.swatchPanel.value;
      else if (a.t === 'hudToggle' || a.t === 'collapse') hud.collapsed.value = !hud.collapsed.value;
      else {
        app.run(a);
        return;
      }
      hud.persist();
    } else if (a.t === 'hudFlip') {
      const wasVisible = hud.visible();
      hud.dispatch({ t: 'key' });
      if (wasVisible) app.run(a); // first Tab only shows the HUD; the next flips main <-> swatch bar
    } else if (a.t === 'hudToggle' || a.t === 'collapse') hud.dispatch({ t: 'toggle' });
    else app.run(a);
    return;
  }
  if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  engine.key(ev.code, ev.key); // Blindness reveal (R)
  client.event('key', ev.code); // Repeat toggle (B)
  request();
});

new ResizeObserver(resize).observe(stage);
resize();

if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__athanor = { engine, client, ring, app, hud };
