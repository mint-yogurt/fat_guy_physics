/**
 * Offline renderer for a Patch. Pure functions over typed arrays: no Web
 * Audio, no DOM, no randomness other than a fixed-seed PRNG, so the same
 * patch + note always renders the same samples (a code *is* a sound).
 *
 * Voice = OSC + FM + RESO + PLUCK + NOISE summed, shaped by one AD envelope
 * that can drive volume and/or pitch of everything pitched.
 */

import { clampPatch, type Patch } from "./patch.ts";

const TAU = Math.PI * 2;
const LN2 = Math.LN2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const smoothstep = (t: number) => t * t * (3 - 2 * t);
const mtof = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Walks a table of keyframes with a 0..1 position, handing back the two neighbours and the blend. */
function seg(pos: number, count: number): [number, number, number] {
  const x = clamp(pos, 0, 1) * (count - 1);
  const i = Math.min(Math.floor(x), count - 2);
  return [i, i + 1, x - i];
}

// ------------------------------------------------------------------ ENV

export interface EnvShape {
  attack: number; // seconds
  decay: number; // seconds
  /** 0 = linear attack / exponential decay, 1 = raised-cosine both ways. */
  round: number;
}

/**
 * 0..35%   instant attack, decay 0.04s -> 2s
 * 35..50%  attack slews open, decay eases, curves round off
 * 50%      smooth sine hump, 1s up / 1s down
 * 50..100% attack keeps stretching while the decay tightens (slow in, quick out)
 */
export function envShape(slider: number): EnvShape {
  const t = clamp(slider, 0, 255) / 255;
  if (t <= 0.35) {
    return { attack: 0.001, decay: 0.04 * Math.pow(50, t / 0.35), round: 0 };
  }
  if (t <= 0.5) {
    const k = smoothstep((t - 0.35) / 0.15);
    return { attack: 0.001 * Math.pow(1000, k), decay: 2 * Math.pow(0.5, k), round: k };
  }
  const u = (t - 0.5) / 0.5;
  return { attack: Math.pow(1.6, u), decay: Math.pow(0.12, u), round: 1 };
}

export function envLength(slider: number): number {
  const s = envShape(slider);
  return s.attack + s.decay;
}

const E5 = Math.exp(-5);

export function envValue(s: EnvShape, t: number): number {
  if (t < s.attack) {
    const x = t / s.attack;
    return lerp(x, 0.5 - 0.5 * Math.cos(Math.PI * x), s.round);
  }
  const y = (t - s.attack) / s.decay;
  if (y >= 1) return 0;
  return lerp((Math.exp(-5 * y) - E5) / (1 - E5), 0.5 + 0.5 * Math.cos(Math.PI * y), s.round);
}

/** Full-scale pitch sweep is 4 octaves, tapered so the first half of the knob is fine control. */
export function pitchSemitones(knob: number): number {
  const a = clamp(knob, -127, 127) / 127;
  return Math.sign(a) * a * a * 48;
}

// ------------------------------------------------------------------ OSC

const OSC_NAMES = ["sine", "triangle", "sharktooth", "saw", "square"] as const;
export { OSC_NAMES };
// Rough loudness matching so the morph doesn't jump as harmonics are added.
const OSC_GAIN = [1, 1.2, 1.45, 1.1, 0.7];

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

function pulseWave(ph: number, dt: number, duty: number): number {
  let v = ph < duty ? 1 : -1;
  v += polyBlep(ph, dt);
  v -= polyBlep(ph >= duty ? ph - duty : ph - duty + 1, dt);
  return v - (2 * duty - 1); // DC-free, otherwise thin pulses just thump
}

class Osc {
  private phase = 0;
  private readonly w = [0, 0, 0, 0, 0];
  private duty = 0.5;
  private gate = 1;

  constructor(slider: number) {
    const pos = ((slider - 1) / 254) * 5; // 0..4 morph, 4..5 pulse narrowing to nothing
    if (pos <= 4) {
      const i = Math.min(Math.floor(pos), 3);
      this.w[i] = 1 - (pos - i);
      this.w[i + 1] = pos - i;
    } else {
      this.w[4] = 1;
      this.duty = 0.5 * (1 - (pos - 4));
      this.gate = clamp(this.duty / 0.05, 0, 1);
    }
  }

  tick(f: number, sr: number): number {
    const dt = f / sr;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    const ph = this.phase, w = this.w;
    let out = 0;
    if (w[0]!) out += w[0]! * OSC_GAIN[0]! * Math.sin(TAU * ph);
    if (w[1]!) {
      const x = ph < 0.25 ? ph + 0.75 : ph - 0.25;
      out += w[1]! * OSC_GAIN[1]! * (4 * Math.abs(x - 0.5) - 1);
    }
    const saw = w[2]! || w[3]! ? 2 * ph - 1 - polyBlep(ph, dt) : 0;
    if (w[2]!) out += w[2]! * OSC_GAIN[2]! * 0.5 * (Math.sin(TAU * ph) + saw);
    if (w[3]!) out += w[3]! * OSC_GAIN[3]! * saw;
    if (w[4]!) out += w[4]! * OSC_GAIN[4]! * this.gate * pulseWave(ph, dt, this.duty);
    return out;
  }
}

// ------------------------------------------------------------------- FM

// [ratio, index] keyframes: soft warmth -> bell -> metal bar -> clangorous.
const FM_KEYS: ReadonlyArray<readonly [number, number]> = [
  [2.0, 0.4], [3.5, 1.8], [1.4, 3.0], [2.76, 5.5], [7.13, 8.0],
];

class Fm {
  private pc = 0;
  private pm = 0;
  private readonly ratio: number;
  private readonly index: number;

  constructor(slider: number) {
    const [a, b, k] = seg((slider - 1) / 254, FM_KEYS.length);
    const A = FM_KEYS[a]!, B = FM_KEYS[b]!;
    this.ratio = Math.exp(lerp(Math.log(A[0]), Math.log(B[0]), k));
    this.index = lerp(A[1], B[1], k);
  }

  /** `bright` is the envelope: the modulation index follows it, so tones start/end duller like struck metal. */
  tick(f: number, sr: number, bright: number): number {
    this.pc += f / sr;
    this.pm += Math.min(f * this.ratio, sr * 0.45) / sr;
    this.pc -= Math.floor(this.pc);
    this.pm -= Math.floor(this.pm);
    return Math.sin(TAU * this.pc + this.index * (0.25 + 0.75 * bright) * Math.sin(TAU * this.pm));
  }
}

// ----------------------------------------------------------------- NOISE

class NoiseGen {
  private readonly rng: () => number;
  private b0 = 0; private b1 = 0; private b2 = 0; private b3 = 0; private b4 = 0; private b5 = 0; private b6 = 0;
  private acc = 0;
  private held = 0;
  private readonly mix: number; // pink(0) .. white(1)
  private readonly crush: number; // 0..1, 0 = clean
  private readonly levels: number;

  constructor(seed: number, slider: number, private readonly sr: number) {
    this.rng = mulberry32(seed);
    this.mix = clamp((slider - 1) / 99, 0, 1);
    this.crush = clamp((slider - 100) / 155, 0, 1);
    this.levels = Math.pow(2, 15 - this.crush * 13); // 16 bits -> 3 bits
  }

  /** `f` is the voice pitch: past white, the sample-and-hold clock sinks toward it, so the noise gets a pitch like a chip channel. */
  tick(f: number): number {
    const w = this.rng() * 2 - 1;
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.969 * this.b2 + w * 0.153852;
    this.b3 = 0.8665 * this.b3 + w * 0.3104856;
    this.b4 = 0.55 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.016898;
    const pink = (this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362) * PINK_NORM;
    this.b6 = w * 0.115926;
    let out = lerp(pink, w * WHITE_NORM, this.mix);
    if (this.crush > 0) {
      const clock = this.sr * Math.pow(Math.max(0.7 * f, 1) / this.sr, this.crush);
      this.acc += clock / this.sr;
      if (this.acc >= 1) {
        this.acc -= Math.floor(this.acc);
        this.held = Math.round(w * WHITE_NORM * this.levels) / this.levels;
      }
      out = this.held;
    }
    return out;
  }
}

const WHITE_NORM = 0.9;
const PINK_NORM = 0.11 * 2.6; // measured: matches white's RMS

// ------------------------------------------------------------------ RESO

const MODES = 8;
interface ResoProfile {
  name: string;
  ratios: number[];
  amps: number[];
  /** Fundamental decay in seconds; mode i decays as d0 * ratio^-tilt. */
  d0: number;
  tilt: number;
  /** Initial pitch multiplier that falls to 1 within ~30ms (drum thump). */
  drop: number;
  click: number;
  /** One-pole coefficient colouring the strike click (small = dark). */
  clickC: number;
}

const RESO_PROFILES: ResoProfile[] = [
  { name: "woodblock", ratios: [1, 2.4, 3.9, 5.6, 7.4, 9.5, 11.6, 14], amps: [1, 0.6, 0.35, 0.2, 0.12, 0.08, 0.05, 0.03], d0: 0.07, tilt: 1, drop: 1, click: 0.5, clickC: 0.6 },
  { name: "thud", ratios: [1, 1.59, 2.14, 2.3, 2.65, 2.92, 3.16, 3.5], amps: [1, 0.7, 0.5, 0.4, 0.25, 0.2, 0.12, 0.08], d0: 0.22, tilt: 1.5, drop: 1.8, click: 0.3, clickC: 0.06 },
  { name: "machinery", ratios: [1, 1.47, 2.09, 2.57, 3.72, 4.31, 5.93, 7.1], amps: [0.8, 1, 0.7, 0.8, 0.5, 0.5, 0.3, 0.3], d0: 0.18, tilt: 0.4, drop: 1, click: 1, clickC: 0.85 },
  { name: "clang", ratios: [1, 2.76, 5.4, 8.93, 13.34, 18.64, 24.8, 31.8], amps: [1, 0.9, 0.7, 0.55, 0.4, 0.3, 0.2, 0.15], d0: 0.9, tilt: 0.5, drop: 1, click: 0.4, clickC: 0.9 },
  { name: "glass", ratios: [1, 2.32, 4.25, 6.63, 9.38, 12.5, 16, 19.8], amps: [1, 0.6, 0.5, 0.35, 0.3, 0.2, 0.12, 0.08], d0: 1.6, tilt: 0.3, drop: 1, click: 0.15, clickC: 1 },
];
export const RESO_NAMES = RESO_PROFILES.map((p) => p.name);

class Reso {
  private readonly ratio = new Float64Array(MODES);
  private readonly amp = new Float64Array(MODES);
  private readonly decayMul = new Float64Array(MODES);
  private readonly phase = new Float64Array(MODES);
  private readonly drop: number;
  private readonly click: number;
  private readonly clickC: number;
  private readonly clickMul: number;
  private clickEnv = 1;
  private clickLp = 0;
  private dropEnv = 1;
  private readonly dropMul: number;
  private readonly rng = mulberry32(0xbeef);

  constructor(slider: number, private readonly sr: number) {
    const [ia, ib, k] = seg((slider - 1) / 254, RESO_PROFILES.length);
    const A = RESO_PROFILES[ia]!, B = RESO_PROFILES[ib]!;
    const d0 = Math.exp(lerp(Math.log(A.d0), Math.log(B.d0), k));
    const tilt = lerp(A.tilt, B.tilt, k);
    let norm = 0;
    for (let i = 0; i < MODES; i++) {
      this.ratio[i] = Math.exp(lerp(Math.log(A.ratios[i]!), Math.log(B.ratios[i]!), k));
      this.amp[i] = lerp(A.amps[i]!, B.amps[i]!, k);
      norm += this.amp[i]! ** 2;
      const tau = Math.max(d0 * Math.pow(this.ratio[i]!, -tilt), 0.003);
      this.decayMul[i] = Math.exp(-1 / (tau * sr));
    }
    norm = 0.55 / Math.sqrt(norm);
    for (let i = 0; i < MODES; i++) this.amp[i] = this.amp[i]! * norm;
    this.drop = lerp(A.drop, B.drop, k);
    this.click = lerp(A.click, B.click, k);
    this.clickC = lerp(A.clickC, B.clickC, k);
    this.clickMul = Math.exp(-1 / (0.003 * sr));
    this.dropMul = Math.exp(-1 / (0.03 * sr));
  }

  tick(f: number): number {
    const sr = this.sr;
    const fd = f * (1 + (this.drop - 1) * this.dropEnv);
    this.dropEnv *= this.dropMul;
    let out = 0;
    for (let i = 0; i < MODES; i++) {
      const a = this.amp[i]!;
      if (a < 1e-6) continue;
      const fi = fd * this.ratio[i]!;
      if (fi < sr * 0.45) {
        let ph = this.phase[i]! + fi / sr;
        ph -= Math.floor(ph);
        this.phase[i] = ph;
        out += a * Math.sin(TAU * ph);
      }
      this.amp[i] = a * this.decayMul[i]!;
    }
    if (this.clickEnv > 1e-4) {
      this.clickLp += this.clickC * (this.rng() * 2 - 1 - this.clickLp);
      out += this.clickLp * this.clickEnv * this.click * 0.6;
      this.clickEnv *= this.clickMul;
    }
    return out;
  }
}

// ----------------------------------------------------------------- PLUCK

interface PluckProfile {
  name: string;
  t60: number; // seconds for the loop to fall 60dB
  bright: number; // loop low-pass coefficient, 1 = open
  disp: number; // all-pass dispersion; stretches the harmonics out of tune
  drive: number; // loop saturation, adds buzz
  glide: number; // semitones above pitch at the pluck, settling back
  glideTau: number;
  rate: number; // random re-excitations per second
  burst: number; // excitation length in periods
}

const PLUCK_PROFILES: PluckProfile[] = [
  { name: "pluck", t60: 0.9, bright: 0.55, disp: 0, drive: 0, glide: 0, glideTau: 0.05, rate: 0, burst: 1 },
  { name: "elastic", t60: 0.6, bright: 0.75, disp: 0.45, drive: 0, glide: 9, glideTau: 0.09, rate: 0, burst: 0.7 },
  { name: "wire", t60: 3, bright: 0.9, disp: 0.08, drive: 2.5, glide: 0, glideTau: 0.05, rate: 0, burst: 1 },
  { name: "rain on tin", t60: 0.35, bright: 0.95, disp: 0.6, drive: 0, glide: 0, glideTau: 0.05, rate: 40, burst: 0.5 },
];
export const PLUCK_NAMES = PLUCK_PROFILES.map((p) => p.name);

class Pluck {
  private readonly buf: Float32Array;
  private w = 0;
  private lp = 0;
  private ap1x = 0; private ap1y = 0; private ap2x = 0; private ap2y = 0;
  private remaining = 0;
  private burstAmp = 1;
  private readonly rng = mulberry32(0x51ed);
  private readonly p: PluckProfile;
  private t = 0;

  constructor(slider: number, private readonly sr: number, private readonly noise: NoiseGen) {
    this.buf = new Float32Array(Math.ceil(sr / 8) + 4);
    const [ia, ib, k] = seg((slider - 1) / 254, PLUCK_PROFILES.length);
    const A = PLUCK_PROFILES[ia]!, B = PLUCK_PROFILES[ib]!;
    this.p = {
      name: "",
      t60: Math.exp(lerp(Math.log(A.t60), Math.log(B.t60), k)),
      bright: lerp(A.bright, B.bright, k),
      disp: lerp(A.disp, B.disp, k),
      drive: lerp(A.drive, B.drive, k),
      glide: lerp(A.glide, B.glide, k),
      glideTau: lerp(A.glideTau, B.glideTau, k),
      rate: lerp(A.rate, B.rate, k),
      burst: lerp(A.burst, B.burst, k),
    };
  }

  tick(f: number): number {
    const { sr, buf, p } = this;
    const len = buf.length;
    const fg = f * Math.pow(2, (p.glide * Math.exp(-this.t / p.glideTau)) / 12);
    this.t += 1 / sr;
    const period = sr / fg;
    const burstLen = Math.max(6, Math.round(period * p.burst));
    if (this.t <= 1 / sr) {
      this.remaining = burstLen;
      this.burstAmp = 1;
    } else if (p.rate > 0 && this.rng() < p.rate / sr) {
      this.remaining = Math.max(6, Math.round(burstLen * 0.5));
      this.burstAmp = 0.3 + 0.7 * this.rng();
    }

    const delay = clamp(period - 1.2, 2, len - 3);
    let rp = this.w - delay;
    if (rp < 0) rp += len;
    const i0 = Math.floor(rp), fr = rp - i0;
    const x = lerp(buf[i0]!, buf[i0 + 1 >= len ? 0 : i0 + 1]!, fr);

    this.lp += p.bright * (x - this.lp);
    let y = this.lp;
    if (p.disp > 0) {
      const a = p.disp;
      const y1 = a * y + this.ap1x - a * this.ap1y; this.ap1x = y; this.ap1y = y1;
      const y2 = a * y1 + this.ap2x - a * this.ap2y; this.ap2x = y1; this.ap2y = y2;
      y = y2;
    }
    y *= Math.exp(-6.9078 / (p.t60 * fg));
    if (p.drive > 0) {
      const kd = 1 + p.drive;
      y = Math.tanh(y * kd) / kd;
    }
    let ex = 0;
    if (this.remaining > 0) {
      this.remaining--;
      ex = this.noise.tick(fg) * this.burstAmp;
    }
    const v = y + ex;
    buf[this.w] = v;
    if (++this.w >= len) this.w = 0;
    return v;
  }
}

// ---------------------------------------------------------------- render

export interface RenderOptions {
  sampleRate?: number;
  /** MIDI note override (fractional ok). Defaults to patch.note. */
  note?: number;
  /** Seconds of ring-out after the envelope ends. Default 0.03. */
  tail?: number;
}

const MIX = { osc: 0.5, fm: 0.4, reso: 0.8, pluck: 1.1, noise: 0.35 };

export function renderPatch(input: Partial<Patch>, opts: RenderOptions = {}): Float32Array {
  const p = clampPatch(input);
  const sr = opts.sampleRate ?? 48000;
  const baseFreq = mtof(opts.note ?? p.note);
  const env = envShape(p.env);
  const tail = opts.tail ?? 0.03;
  const total = env.attack + env.decay + tail;
  const n = Math.ceil(total * sr);
  const out = new Float32Array(n);

  const osc = p.osc > 0 ? new Osc(p.osc) : null;
  const fm = p.fm > 0 ? new Fm(p.fm) : null;
  const reso = p.reso > 0 ? new Reso(p.reso, sr) : null;
  const noise = p.noise > 0 ? new NoiseGen(0x1234, p.noise, sr) : null;
  // The pluck's exciter is "the noise slider", on its own random stream; if the
  // slider is off it falls back to plain white so PLUCK never goes mute.
  const pluck = p.pluck > 0 ? new Pluck(p.pluck, sr, new NoiseGen(0x9876, p.noise > 0 ? p.noise : 100, sr)) : null;

  const volAmt = p.envVol / 127;
  const pitchSemis = pitchSemitones(p.envPitch);
  const fadeStart = Math.max(0, n - Math.floor(0.01 * sr));

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const e = envValue(env, t);
    const f = clamp(baseFreq * Math.exp((pitchSemis * e * LN2) / 12), 8, sr * 0.45);

    let mix = 0;
    if (osc) mix += MIX.osc * osc.tick(f, sr);
    if (fm) mix += MIX.fm * fm.tick(f, sr, e);
    if (reso) mix += MIX.reso * reso.tick(f);
    if (pluck) mix += MIX.pluck * pluck.tick(f);
    if (noise) mix += MIX.noise * noise.tick(f);

    const a = Math.abs(volAmt);
    const gain = 1 - a + a * (volAmt >= 0 ? e : 1 - e);
    let s = Math.tanh(mix * gain);
    if (i >= fadeStart) s *= (n - i) / (n - fadeStart);
    out[i] = s;
  }
  return out;
}
