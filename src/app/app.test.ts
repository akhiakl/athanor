import { describe, expect, it } from 'vitest';
import { hudInitial, hudNext, type HudEvent } from '../hud/hudState';
import { Engine } from '../engine/engine';
import { repeatStamps } from '../modules/affect/repeatStamps';
import { PHASE_DOWN, PHASE_MOVE, PHASE_UP, InputRing, KIND_MOUSE, packMeta } from '../core/inputRing';
import { CaptureSink } from '../test/helpers';
import { affectMenu, colorRgba, createApp, rgbaColor } from './app';
import { defaultValues, toParams } from './controls';
import { isTextEntry, matchShortcut } from './shortcuts';
import type { RenderClient } from '../render/client';

const none = { mod: false, shift: false, alt: false };

describe('shortcut map (1.3.1)', () => {
  it('maps digits to create modules, with Alt giving 11..20', () => {
    expect(matchShortcut('Digit1', none)).toEqual({ t: 'create', i: 0 });
    expect(matchShortcut('Digit0', none)).toEqual({ t: 'create', i: 9 });
    expect(matchShortcut('Digit1', { ...none, alt: true })).toEqual({ t: 'create', i: 10 });
  });
  it('maps Mod+digit to affects, with Shift giving 11..20', () => {
    expect(matchShortcut('Digit3', { ...none, mod: true })).toEqual({ t: 'affect', i: 2 });
    expect(matchShortcut('Digit1', { mod: true, shift: true, alt: false })).toEqual({ t: 'affect', i: 10 });
  });
  it('distinguishes S, Mod+S and X, Shift+X by modifier', () => {
    expect(matchShortcut('KeyS', none)).toEqual({ t: 'style' });
    expect(matchShortcut('KeyS', { ...none, mod: true })).toBeNull(); // session save is not bound yet
    expect(matchShortcut('KeyX', none)).toEqual({ t: 'colorToBg' });
    expect(matchShortcut('KeyX', { ...none, shift: true })).toEqual({ t: 'swapColors' });
  });
  it('handles width, alpha, swatches and clear', () => {
    expect(matchShortcut('BracketRight', none)).toEqual({ t: 'width', d: 1 });
    expect(matchShortcut('NumpadMultiply', none)).toEqual({ t: 'alpha', d: 10 });
    expect(matchShortcut('Equal', { ...none, alt: true })).toEqual({ t: 'alpha', d: 10 });
    expect(matchShortcut('NumpadAdd', none)).toEqual({ t: 'swatchStep', d: 1 });
    expect(matchShortcut('Numpad7', none)).toEqual({ t: 'swatchPick', i: 7 });
    expect(matchShortcut('Backspace', { ...none, mod: true })).toEqual({ t: 'clear' });
    expect(matchShortcut('Backspace', none)).toBeNull();
    expect(matchShortcut('Period', { ...none, mod: true })).toEqual({ t: 'collapse' });
  });
  it('leaves Blindness R and Repeat B to the modules', () => {
    expect(matchShortcut('KeyR', none)).toBeNull();
    expect(matchShortcut('KeyB', none)).toBeNull();
  });
});

describe('typing targets', () => {
  it('suppresses hotkeys only for text-like fields', () => {
    expect(isTextEntry({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'number' })).toBe(true);
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEntry({ tagName: 'SELECT' })).toBe(true);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });
  it('keeps hotkeys alive after a checkbox, radio, slider or button', () => {
    for (const type of ['checkbox', 'radio', 'range', 'button']) expect(isTextEntry({ tagName: 'INPUT', type })).toBe(false);
    expect(isTextEntry({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe('HUD state machine (1.4)', () => {
  const run = (evs: HudEvent[]) => evs.reduce(hudNext, hudInitial());
  const move = (y: number, extra: Partial<Extract<HudEvent, { t: 'move' }>> = {}): HudEvent => ({ t: 'move', y, h: 40, popup: false, stroke: false, ...extra });

  it('shows at the top edge, fades in the peek band, hides below', () => {
    expect(run([move(5)]).state).toBe('SHOWN');
    const peek = run([move(29)]);
    expect(peek.state).toBe('PEEK');
    expect(peek.opacity).toBeCloseTo(0.5, 5);
    expect(run([move(29), move(60)]).state).toBe('HIDDEN');
  });
  it('hides below the bar, but arms a timer while a popup is open', () => {
    expect(run([move(5), move(100)]).state).toBe('HIDDEN');
    const armed = run([move(5), move(100, { popup: true })]);
    expect(armed).toMatchObject({ state: 'SHOWN', timer: true });
    expect(hudNext(armed, { t: 'timer', insideHud: false, popup: false }).state).toBe('HIDDEN');
    expect(hudNext(armed, { t: 'timer', insideHud: true, popup: false }).state).toBe('SHOWN');
  });
  it('ignores proximity during a stroke and hides on pointerdown', () => {
    expect(run([move(5, { stroke: true })]).state).toBe('HIDDEN');
    expect(run([move(5), { t: 'down' }]).state).toBe('HIDDEN');
  });
  it('Tab keys it on until the pointer has entered and left', () => {
    const keyed = run([{ t: 'key' }, move(500)]);
    expect(keyed.state).toBe('KEYED');
    expect(hudNext(keyed, { t: 'leave' }).state).toBe('KEYED'); // never entered
    expect(run([{ t: 'key' }, { t: 'enter' }, { t: 'leave' }]).state).toBe('SHOWN');
  });
  it('Space toggles, and DOCKED ignores everything but un-docking', () => {
    expect(run([{ t: 'toggle' }]).state).toBe('KEYED');
    expect(run([{ t: 'toggle' }, { t: 'toggle' }]).state).toBe('HIDDEN');
    expect(run([{ t: 'dock', on: true }, move(500), { t: 'down' }]).state).toBe('DOCKED');
  });
});

describe('control specs (6.2)', () => {
  it('maps displayed values to module parameters', () => {
    expect(toParams('affect.repeat', { repeat: true, gap: 50 })).toEqual({ repeat: true, gap: 150 }); // gap = 2v + 50
    expect(toParams('affect.repeat', defaultValues('affect.repeat'))).toEqual({ repeat: true, gap: 150 });
    expect(toParams('create.scrawlShapes', {})).toEqual({ flow: 10, detail: 10, noise: 10 });
  });
});

describe('app controller', () => {
  const setup = () => {
    const sink = new CaptureSink();
    const e = new Engine(1, sink);
    const sent: unknown[] = [];
    const client = {
      setAffect: (id: string, on: boolean, p?: unknown) => sent.push([id, on, p]),
      clear: () => sent.push('clear'),
    } as unknown as RenderClient;
    const app = createApp(e, client, repeatStamps(), { redraw: () => {} });
    return { e, app, sent, sink };
  };
  const stroke = (e: Engine) => {
    const ring = new InputRing();
    ring.write(0, 0, 0, 1, 0, 0, 1, packMeta(KIND_MOUSE, PHASE_DOWN, 0));
    ring.write(20, 0, 10, 1, 0, 0, 1, packMeta(KIND_MOUSE, PHASE_MOVE, 0));
    ring.write(40, 0, 20, 1, 0, 0, 1, packMeta(KIND_MOUSE, PHASE_UP, 0));
    e.tick(ring);
  };

  it('applies style, line width (clamped) and colour to the engine', () => {
    const { e, app } = setup();
    app.run({ t: 'style' });
    expect(e.attrs.fill).toBe(true);
    app.run({ t: 'width', d: -5 });
    expect(e.attrs.lineWidth).toBe(1);
    app.setLineWidth(500);
    expect(e.attrs.lineWidth).toBe(75);
    app.pickSwatch(2);
    expect(e.attrs.rgba >>> 0).toBe(0xe63946ff);
  });
  it('alpha lock keeps the alpha when a swatch is picked', () => {
    const { e, app } = setup();
    app.setAlpha(100);
    app.alphaLock.value = true;
    app.pickSwatch(2);
    expect(e.attrs.rgba & 255).toBe(100);
    app.alphaLock.value = false;
    app.pickSwatch(2);
    expect(e.attrs.rgba & 255).toBe(255);
  });
  it('alpha controls still work while alpha is locked', () => {
    const { e, app } = setup();
    app.alphaLock.value = true;
    app.setAlpha(100);
    expect(e.attrs.rgba & 255).toBe(100);
    app.run({ t: 'alpha', d: -10 });
    expect(e.attrs.rgba & 255).toBe(90);
    app.setColor({ ...app.color.value, a: 40 }); // the picker's alpha strip
    expect(e.attrs.rgba & 255).toBe(40);
  });
  it('X switches to the background colour and back; Shift+X swaps slots', () => {
    const { e, app } = setup();
    app.pickSwatch(2);
    app.run({ t: 'colorToBg' });
    expect(e.attrs.rgba >>> 0).toBe(0xffffffff);
    app.run({ t: 'colorToBg' });
    expect(e.attrs.rgba >>> 0).toBe(0xe63946ff);
    app.run({ t: 'swapColors' });
    expect(e.attrs.rgba >>> 0).toBe(0xffffffff);
  });
  it('selects create modules and toggles active and committed affects', () => {
    const { e, app, sent } = setup();
    app.run({ t: 'create', i: 1 });
    expect(app.createId.value).toBe('create.speedShapes');
    app.run({ t: 'affect', i: affectMenu.indexOf('affect.mirror') });
    expect(e.hasAffect('affect.mirror')).toBe(true);
    app.run({ t: 'affect', i: affectMenu.indexOf('affect.random') });
    expect(sent).toEqual([['affect.random', true, { distortion: 50 }]]);
    app.run({ t: 'affect', i: affectMenu.indexOf('affect.mirror') });
    expect(e.hasAffect('affect.mirror')).toBe(false);
  });
  it('a control change rebuilds the module with new parameters', () => {
    const { e, app, sent } = setup();
    app.setAffect('affect.mirror', true);
    app.setValue('affect.mirror', 'vertical', true);
    stroke(e); // rebuilt module keeps working through a stroke
    app.setAffect('affect.repeat', true);
    app.setValue('affect.repeat', 'gap', 0);
    expect(sent.at(-1)).toEqual(['affect.repeat', true, { repeat: true, gap: 50 }]);
  });
  it('Mirror axis can be moved and reset', () => {
    const { e, app } = setup();
    e.view.w = 800; e.view.h = 600;
    app.setAffect('affect.mirror', true);
    stroke(e);
    expect(app.mirrorAxis()).toEqual([400, 300]);
    app.moveAxis(100, 50);
    expect(app.mirrorAxis()).toEqual([100, 50]);
    app.press('mirror.reset');
    stroke(e);
    expect(app.mirrorAxis()).toEqual([400, 300]);
  });
  it('colour round-trips through HSB', () => {
    expect(colorRgba(rgbaColor(0x1d70b8ff)) >>> 0).toBe(0x1d70b8ff);
  });
});
