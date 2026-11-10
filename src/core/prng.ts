// mulberry32 PRNG, spec 5.0. One instance per module; no allocation per call.
export class Prng {
  private s: number;
  private spare = 0;
  private hasSpare = false;

  constructor(seed: number) {
    this.s = seed | 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** random(h): [0, h); random(a, b): [a, b) or a when a >= b. */
  random(a: number, b?: number): number {
    if (b === undefined) return a === 0 ? 0 : a * this.next();
    return a >= b ? a : a + (b - a) * this.next();
  }

  /** Standard normal, Box-Muller with cached second value. */
  gauss(): number {
    if (this.hasSpare) {
      this.hasSpare = false;
      return this.spare;
    }
    const u = 1 - this.next(); // (0, 1], avoids log(0)
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    this.hasSpare = true;
    return r * Math.cos(2 * Math.PI * v);
  }
}

/** FNV-1a, for deriving a per-module stream seed: seed ^ hash(moduleId). */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h | 0;
}

export function moduleRng(sessionSeed: number, moduleId: string): Prng {
  return new Prng(sessionSeed ^ hashId(moduleId));
}
