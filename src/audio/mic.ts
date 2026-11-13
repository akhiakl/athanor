// Shared microphone, spec 4.1.1. One AudioContext and one source for every mic module; reference counted.
// shortcut: levels and pitch use AnalyserNodes (the spec's fallback path) instead of an AudioWorklet; the worklet is a later step.
import { signal } from '@preact/signals';
import { computeLevels, emptyLevels, estimatePitch, type Levels } from './analysis';

export type MicState = 'idle' | 'requesting' | 'running' | 'suspended' | 'denied' | 'nodevice' | 'error';

/** What a mic-driven module reads. Tests pass a stub. */
export interface AudioSource {
  levels(): Levels;
  /** Hz, or 0 when the signal is below the gate. */
  pitch(gateDb: number): number;
}

export const MIC_MESSAGE: Partial<Record<MicState, string>> = {
  requesting: 'Waiting for the microphone',
  denied: 'Microphone blocked',
  nodevice: 'No microphone found',
  error: 'Microphone unavailable',
};

const LEVEL_FFT = 512;
const PITCH_FFT = 2048;
const PITCH_EVERY_MS = 16;
const CLOSE_AFTER_MS = 2000;

export class Mic implements AudioSource {
  readonly state = signal<MicState>('idle');
  private refs = 0;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private level: AnalyserNode | null = null;
  private spectrum: AnalyserNode | null = null;
  private readonly block = new Float32Array(LEVEL_FFT);
  private readonly bins = new Float32Array(PITCH_FFT / 2);
  private readonly out: Levels = emptyLevels();
  private lastPitch = 0;
  private lastPitchAt = -Infinity;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private gen = 0;
  private visible = (): void => this.onVisibility();

  /** Call from a user gesture (module selection). Pair every acquire with one release. */
  acquire(): void {
    this.refs++;
    clearTimeout(this.closeTimer);
    if (this.refs === 1) void this.open();
  }

  release(): void {
    if (this.refs === 0) return;
    if (--this.refs > 0) return;
    this.gen++; // abandons a request still in flight
    this.stopTracks();
    this.state.value = 'idle';
    this.closeTimer = setTimeout(() => this.closeContext(), CLOSE_AFTER_MS);
  }

  levels(): Levels {
    if (!this.level || this.state.value !== 'running') return Object.assign(this.out, emptyLevels());
    this.level.getFloatTimeDomainData(this.block);
    return computeLevels(this.block, this.out);
  }

  pitch(gateDb: number): number {
    if (!this.spectrum || !this.ctx || this.state.value !== 'running') return 0;
    const now = performance.now();
    if (now - this.lastPitchAt < PITCH_EVERY_MS) return this.lastPitch;
    this.lastPitchAt = now;
    this.spectrum.getFloatFrequencyData(this.bins);
    const p = estimatePitch(this.bins, this.ctx.sampleRate, PITCH_FFT, gateDb);
    if (p > 0) this.lastPitch = p;
    return this.lastPitch;
  }

  private async open(): Promise<void> {
    const gen = ++this.gen;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.state.value = 'error';
      return;
    }
    this.state.value = 'requesting';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      if (gen !== this.gen) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      this.stream = stream;
      const ctx = (this.ctx ??= new AudioContext({ latencyHint: 'interactive' }));
      const src = ctx.createMediaStreamSource(stream);
      this.level = ctx.createAnalyser();
      this.level.fftSize = LEVEL_FFT;
      this.level.smoothingTimeConstant = 0;
      this.spectrum = ctx.createAnalyser();
      this.spectrum.fftSize = PITCH_FFT;
      this.spectrum.smoothingTimeConstant = 0;
      this.spectrum.minDecibels = -100;
      this.spectrum.maxDecibels = 0;
      src.connect(this.level);
      src.connect(this.spectrum);
      document.addEventListener('visibilitychange', this.visible);
      await ctx.resume();
      if (gen === this.gen) this.state.value = document.hidden ? 'suspended' : 'running';
    } catch (err) {
      if (gen !== this.gen) return;
      const name = (err as DOMException | undefined)?.name;
      this.state.value = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'nodevice' : 'error';
    }
  }

  private onVisibility(): void {
    if (this.refs === 0 || !this.ctx) return;
    if (document.hidden && this.state.value === 'running') {
      void this.ctx.suspend();
      this.state.value = 'suspended';
    } else if (!document.hidden && this.state.value === 'suspended') {
      void this.ctx.resume();
      this.state.value = 'running';
    }
  }

  private stopTracks(): void {
    document.removeEventListener('visibilitychange', this.visible);
    for (const t of this.stream?.getTracks() ?? []) t.stop(); // frees the OS mic indicator
    this.stream = null;
    this.level = this.spectrum = null;
  }

  private closeContext(): void {
    if (this.refs > 0 || !this.ctx) return;
    void this.ctx.close();
    this.ctx = null;
  }
}

export const mic = new Mic();
