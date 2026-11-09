// Processing-style value noise, spec 5.0 (legacy AlcMath.noise).
import { Prng } from './prng';

const SIZE = 4095;
const OCTAVES = 4;
const FALLOFF = 0.5;
const AMP0 = 0.5;

const cosLUT = new Float64Array(720);
for (let i = 0; i < 720; i++) cosLUT[i] = Math.cos((i * 0.5 * Math.PI) / 180);

const fade = (t: number): number => 0.5 * (1 - cosLUT[Math.trunc(t * 360) % 720]);

export class Noise {
  private perlin = new Float64Array(SIZE + 1);

  constructor(seed: number) {
    this.seed(seed);
  }

  seed(seed: number): void {
    const r = new Prng(seed);
    for (let i = 0; i <= SIZE; i++) this.perlin[i] = r.next();
  }

  /** Range [0, 0.9375). */
  noise(x: number, y = 0, z = 0): number {
    const p = this.perlin;
    x = Math.abs(x);
    y = Math.abs(y);
    z = Math.abs(z);
    let xi = Math.trunc(x);
    let yi = Math.trunc(y);
    let zi = Math.trunc(z);
    let xf = x - xi;
    let yf = y - yi;
    let zf = z - zi;
    let r = 0;
    let amp = AMP0;
    for (let o = 0; o < OCTAVES; o++) {
      let of = xi + (yi << 4) + (zi << 8);
      const rxf = fade(xf);
      const ryf = fade(yf);
      let n1 = p[of & SIZE];
      n1 += rxf * (p[(of + 1) & SIZE] - n1);
      let n2 = p[(of + 16) & SIZE];
      n2 += rxf * (p[(of + 17) & SIZE] - n2);
      n1 += ryf * (n2 - n1);
      of += 256;
      n2 = p[of & SIZE];
      n2 += rxf * (p[(of + 1) & SIZE] - n2);
      const n3 = p[(of + 16) & SIZE] + rxf * (p[(of + 17) & SIZE] - p[(of + 16) & SIZE]);
      n2 += ryf * (n3 - n2);
      n1 += fade(zf) * (n2 - n1);
      r += n1 * amp;
      amp *= FALLOFF;
      xi <<= 1;
      xf *= 2;
      yi <<= 1;
      yf *= 2;
      zi <<= 1;
      zf *= 2;
      if (xf >= 1) {
        xi++;
        xf--;
      }
      if (yf >= 1) {
        yi++;
        yf--;
      }
      if (zf >= 1) {
        zi++;
        zf--;
      }
    }
    return r;
  }
}
