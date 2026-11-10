import { PEN_CURSOR, type CreateModule } from '../../engine/engine';

/** PressureShapes, spec 5.3.2: variable-width ribbon along the pen path. */
export function pressureShapes({ amount = 25 } = {}): CreateModule {
  const width = (e: Parameters<NonNullable<CreateModule['down']>>[0], kind: number, pe: number) =>
    kind === PEN_CURSOR && !e.attrs.syntheticPressure ? 1 : pe * amount;
  return {
    id: 'create.pressureShapes',
    rateSensitive: false,
    down(e, s) {
      e.beginSpine();
      e.spineTo(s.x, s.y, width(e, s.penKind, s.pressureEff));
    },
    drag: (e, s) => e.spineTo(s.x, s.y, width(e, s.penKind, s.pressureEff)),
    up: (e) => e.commit(),
  };
}
