// App controller: HUD state (signals) <-> engine/client commands. The engine never imports this; the HUD calls these functions.
import { batch, computed, signal } from '@preact/signals';
import { hsbToRgb, packRgba, rgbToHsb } from '../core/color';
import type { AffectModule, Engine } from '../engine/engine';
import type { MirrorModule } from '../modules/affect/mirror';
import type { repeatStamps } from '../modules/affect/repeatStamps';
import { affectModules, createModules } from '../modules/registry';
import type { RenderClient } from '../render/client';
import { defaultValues, moduleUi, toParams, type Params } from './controls';
import type { Action } from './shortcuts';

export interface Color { h: number; s: number; b: number; a: number }
export const colorRgba = (c: Color): number => {
  const [r, g, bl] = hsbToRgb(c.h, c.s, c.b);
  return packRgba(r, g, bl, c.a);
};
export const rgbaColor = (rgba: number, a = rgba & 255): Color => {
  const [h, s, b] = rgbToHsb((rgba >>> 24) & 255, (rgba >>> 16) & 255, (rgba >>> 8) & 255);
  return { h, s, b, a };
};

/** Committed-domain affects live in the render worker; they follow the active ones in the menu (and Mod+digit numbering). */
const committedIds = ['affect.random', 'affect.smooth', 'affect.limit', 'affect.repeat'] as const;
export const affectMenu: readonly string[] = [...affectModules.map((d) => d.id), ...committedIds];
export const createMenu: readonly string[] = createModules.map((d) => d.id);

const WHITE: Color = { h: 0, s: 0, b: 1, a: 255 };
const DEFAULT_SWATCHES = [0x000000ff, 0xffffffff, 0xe63946ff, 0xf4a261ff, 0xf1fa3cff, 0x2a9d8fff, 0x1d70b8ff, 0x6a4c93ff, 0xff8fabff, 0x8d99aeff];

export const MAX_SWATCHES = 32;

export function createApp(engine: Engine, client: RenderClient, stamps: ReturnType<typeof repeatStamps>, hooks: { redraw(): void }) {
  const lineWidth = signal(1);
  const fill = signal(false);
  const slot = signal<0 | 1>(0);
  const colors = signal<[Color, Color]>([{ h: 0, s: 0, b: 0, a: 255 }, WHITE]);
  const color = computed(() => colors.value[slot.value]);
  const alphaLock = signal(false);
  const swatches = signal<number[]>(DEFAULT_SWATCHES);
  const swatchIndex = signal(0);
  const previous = signal<Color | null>(null); // X: colour before it was switched to the background colour
  const bg = signal<Color>(WHITE);
  const createId = signal(createMenu[0]);
  const affectsOn = signal<ReadonlySet<string>>(new Set());
  const values = signal<Record<string, Params>>({});
  const bar = signal<'main' | 'swatch'>('main');
  const cursorHidden = signal(false);
  const axisMove = signal(false);
  const canUndo = signal(false);
  const canRedo = signal(false);
  let mirrorRef: MirrorModule | null = null;

  const valuesOf = (id: string): Params => values.value[id] ?? defaultValues(id);
  const paramsOf = (id: string): Params => toParams(id, valuesOf(id));

  function sync(): void {
    engine.attrs.rgba = colorRgba(color.value);
    engine.attrs.lineWidth = lineWidth.value;
    engine.attrs.fill = fill.value;
  }
  sync();

  function setColor(c: Color): void {
    const next: [Color, Color] = [colors.value[0], colors.value[1]];
    next[slot.value] = c;
    colors.value = next;
    sync();
  }

  function makeActive(id: string): AffectModule {
    const m = affectModules.find((d) => d.id === id)!.make(paramsOf(id));
    if (id === 'affect.mirror') mirrorRef = m as MirrorModule;
    return m;
  }

  function selectCreate(i: number): void {
    const d = createModules[i];
    if (!d) return;
    createId.value = d.id;
    engine.select(d.make(paramsOf(d.id)));
  }

  /** Switches one affect on/off; `on` omitted toggles. */
  function setAffect(id: string, on = !affectsOn.value.has(id)): void {
    const next = new Set(affectsOn.value);
    if (on) next.add(id);
    else next.delete(id);
    if ((committedIds as readonly string[]).includes(id)) {
      if (id === 'affect.repeat') {
        if (on) engine.addAffect(stamps);
        else {
          stamps.place(engine); // keep what was stamped
          engine.removeAffect(stamps.id);
        }
      }
      client.setAffect(id, on, on ? paramsOf(id) : undefined);
    } else if (on) engine.addAffect(makeActive(id));
    else {
      engine.removeAffect(id);
      if (id === 'affect.mirror') {
        mirrorRef = null;
        axisMove.value = false;
      }
    }
    affectsOn.value = next;
    hooks.redraw();
  }

  function setValue(id: string, param: string, v: number | boolean): void {
    values.value = { ...values.value, [id]: { ...valuesOf(id), [param]: v } };
    if (id === createId.value) selectCreate(createMenu.indexOf(id));
    else if (affectsOn.value.has(id)) {
      if ((committedIds as readonly string[]).includes(id)) client.setAffect(id, true, paramsOf(id));
      else {
        engine.removeAffect(id);
        engine.addAffect(makeActive(id));
      }
    }
    hooks.redraw();
  }

  function press(action: string): void {
    if (action === 'blindness.reveal') engine.key('KeyR', 'r');
    else if (action === 'mirror.move') axisMove.value = !axisMove.value && mirrorRef !== null;
    else if (action === 'mirror.reset' && mirrorRef) {
      mirrorRef.setAxis(NaN, NaN); // re-centred on the next affect pass
      engine.markDirty();
    }
    hooks.redraw();
  }

  /** Axis-move mode: the pointer places Mirror's axes instead of drawing. */
  function moveAxis(x: number, y: number): void {
    mirrorRef?.setAxis(x, y);
    engine.markDirty();
    hooks.redraw();
  }

  function addSwatch(): void {
    if (swatches.value.length >= MAX_SWATCHES) return;
    swatches.value = [...swatches.value, colorRgba(color.value)];
    swatchIndex.value = swatches.value.length - 1;
  }

  function removeSwatch(): void {
    if (swatches.value.length <= 1) return;
    const i = swatchIndex.value;
    swatches.value = swatches.value.filter((_, k) => k !== i);
    swatchIndex.value = Math.min(i, swatches.value.length - 1);
  }

  function pickSwatch(i: number): void {
    const rgba = swatches.value[i];
    if (rgba === undefined) return;
    swatchIndex.value = i;
    // the lock only stops the swatch's own alpha from applying; the alpha controls still work while it is on
    setColor(rgbaColor(rgba, alphaLock.value ? color.value.a : undefined));
  }

  function setAlpha(a: number): void {
    setColor({ ...color.value, a: Math.max(0, Math.min(255, Math.round(a))) });
  }

  function setSlot(s: 0 | 1): void {
    if (slot.value === s) return;
    slot.value = s;
    sync();
  }

  /** Runs a shortcut action; returns false when it needs HUD handling (the caller owns the HUD state machine). */
  function run(a: Action): void {
    batch(() => {
      switch (a.t) {
        case 'style': fill.value = !fill.value; sync(); break;
        case 'width': lineWidth.value = Math.max(1, Math.min(75, lineWidth.value + a.d)); sync(); break;
        case 'create': selectCreate(a.i); break;
        case 'affect': if (affectMenu[a.i]) setAffect(affectMenu[a.i]); break;
        case 'alpha': setAlpha(color.value.a + a.d); break;
        case 'swatchStep': pickSwatch((swatchIndex.value + a.d + swatches.value.length) % swatches.value.length); break;
        case 'swatchPick': pickSwatch(a.i); break;
        case 'colorToBg':
          if (previous.value) {
            setColor(previous.value);
            previous.value = null;
          } else {
            previous.value = color.value;
            setColor(bg.value);
          }
          break;
        case 'swapColors': colors.value = [colors.value[1], colors.value[0]]; sync(); break;
        case 'cursor': cursorHidden.value = !cursorHidden.value; break;
        case 'clear': client.clear(); break;
        case 'undo': client.undo(); break;
        case 'redo': client.redo(); break;
        case 'hudFlip': bar.value = bar.value === 'main' ? 'swatch' : 'main'; break;
        case 'hudToggle': case 'collapse': case 'export': case 'copy': break; // the HUD and the exporter own these
      }
    });
    hooks.redraw();
  }

  selectCreate(0);

  return {
    canUndo, canRedo, lineWidth, fill, slot, colors, color, alphaLock, swatches, swatchIndex, createId, affectsOn, values, bar, cursorHidden, axisMove,
    valuesOf, setColor, selectCreate, setAffect, setValue, press, moveAxis, addSwatch, removeSwatch, pickSwatch, setAlpha, setSlot, run,
    setLineWidth: (n: number) => { lineWidth.value = Math.max(1, Math.min(75, Math.round(n))); sync(); },
    setFill: (f: boolean) => { fill.value = f; sync(); },
    mirrorAxis: (): [number, number] | null => (mirrorRef ? mirrorRef.axis() : null),
    clear: () => client.clear(),
  };
}
export type App = ReturnType<typeof createApp>;
export { moduleUi };
