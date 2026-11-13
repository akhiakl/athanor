import type { CreateModule } from '../../engine/engine';
import { mic, type AudioSource } from '../../audio/mic';

/** PitchShapes, spec 5.3.3: low pitch is a heavy line, high pitch a thin one; the weight eases toward the target. */
export function pitchShapes(
  { minPitch = 50, maxPitch = 1800, gate = -50, minWeight = 1, maxWeight = 50 } = {},
  src: AudioSource = mic,
  acquire = true,
): CreateModule {
  let weight = minWeight; // persists across strokes
  let pitch = 0;
  const target = (): number => {
    if (pitch <= 0) return weight; // below the gate: hold
    if (pitch >= maxPitch) return minWeight;
    if (pitch <= minPitch) return maxWeight;
    const pn = 1 - (pitch - minPitch) / (maxPitch - minPitch);
    return (maxWeight - minWeight) * pn + minWeight;
  };
  const ease = (): number => {
    const p = src.pitch(gate);
    if (p > 0) pitch = p;
    const d = target() - weight;
    weight += Math.sign(d) * Math.min(2, Math.abs(d));
    return weight;
  };
  if (acquire) mic.acquire();
  return {
    id: 'create.pitchShapes',
    rateSensitive: false,
    down(e, s) {
      e.beginSpine();
      e.spineTo(s.x, s.y, weight);
    },
    drag: (e, s) => e.spineTo(s.x, s.y, ease()),
    up: (e) => e.commit(),
    deselect() {
      if (acquire) mic.release();
    },
  };
}
