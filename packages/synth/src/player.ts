/**
 * Thin Web Audio wrapper: patches are rendered offline by dsp.ts into an
 * AudioBuffer (cached), then triggered as one-shots. Everything goes through
 * `bus`, which is where a reverb / master chain plugs in later.
 */

import { renderPatch } from "./dsp.ts";
import { encodePatch, type Patch } from "./patch.ts";

const CACHE_LIMIT = 256;

export class SynthPlayer {
  readonly ctx: AudioContext;
  /** Connect effects between this and ctx.destination. Defaults to straight through. */
  readonly bus: GainNode;
  private readonly cache = new Map<string, AudioBuffer>();

  constructor(ctx: AudioContext = new AudioContext()) {
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.connect(ctx.destination);
  }

  buffer(patch: Patch, note?: number): AudioBuffer {
    const key = `${encodePatch(patch)}@${note ?? patch.note}`;
    let buf = this.cache.get(key);
    if (buf) {
      this.cache.delete(key); // re-insert: Map order doubles as LRU order
    } else {
      const data = renderPatch(patch, { sampleRate: this.ctx.sampleRate, ...(note !== undefined && { note }) });
      buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
      buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, buf);
    return buf;
  }

  /** Fire a one-shot. `when` is in AudioContext time; omit for now. */
  play(patch: Patch, note?: number, when?: number, gain = 1): AudioBufferSourceNode {
    if (this.ctx.state === "suspended") void this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer(patch, note);
    if (gain === 1) {
      src.connect(this.bus);
    } else {
      const g = this.ctx.createGain();
      g.gain.value = gain;
      src.connect(g).connect(this.bus);
    }
    src.start(when ?? 0);
    return src;
  }
}
