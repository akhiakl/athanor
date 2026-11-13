import { rightAngle } from '../../core/shape';
import type { CreateModule } from '../../engine/engine';
import { mic, type AudioSource } from '../../audio/mic';

export const MIC_ID = 'create.micShapes';

/** MicShapes, spec 5.3.4. `volume` is the 0-100 slider; fatten widens the line with loudness, shake offsets it at right angles. */
export function micShapes({ shake = false, volume = 50 } = {}, src: AudioSource = mic, acquire = true): CreateModule {
  const vol = volume * 0.02;
  const out = new Float32Array(2);
  let lx = 0;
  let ly = 0;
  const width = (): number => Math.max(1, src.levels().legacyLvl * 2 * vol);
  if (acquire) mic.acquire();
  return {
    id: MIC_ID,
    rateSensitive: false,
    down(e, s) {
      lx = s.x;
      ly = s.y;
      if (shake) e.begin(s.x, s.y);
      else {
        e.beginSpine();
        e.spineTo(s.x, s.y, width());
      }
    },
    drag(e, s) {
      if (!shake) {
        e.spineTo(s.x, s.y, width());
        return;
      }
      const l = src.levels();
      const micLevel = l.legacyLvl * 2;
      const lvl = l.b0 === 0 ? micLevel : l.b0 * micLevel;
      rightAngle(s.x, s.y, lx, ly, lvl * vol, out, 0);
      e.curveTo(Math.trunc(out[0]), Math.trunc(out[1]));
      lx = s.x;
      ly = s.y;
    },
    up(e, s) {
      if (shake) e.lineTo(s.x, s.y);
      e.commit();
    },
    deselect() {
      if (acquire) mic.release();
    },
  };
}
