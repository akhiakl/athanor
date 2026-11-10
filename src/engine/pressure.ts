// Velocity-based synthetic pressure, spec 1.2.1.
export class SyntheticPressure {
  private vs = 0;
  private px = 0;
  private py = 0;
  private pt = 0;
  private first = true;

  constructor(private gamma = 1) {}

  reset(): void {
    this.first = true;
    this.vs = 0;
  }

  next(x: number, y: number, t: number): number {
    let syn = 0.6; // first sample of a stroke
    if (!this.first) {
      const dt = Math.max(1, t - this.pt);
      const v = Math.hypot(x - this.px, y - this.py) / dt;
      this.vs += 0.25 * (v - this.vs);
      syn = Math.min(1, Math.max(0.15, 1 - this.vs / 3));
    }
    this.first = false;
    this.px = x;
    this.py = y;
    this.pt = t;
    return syn ** this.gamma;
  }
}
