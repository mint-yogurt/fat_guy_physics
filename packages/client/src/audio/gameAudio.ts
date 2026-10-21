import { decodePatch, SynthPlayer, type Patch } from "@fgp/synth";

import { SFX, type SfxName } from "./sfxBank.ts";

export interface PlayOptions {
  /** Linear volume, 1 = as rendered. */
  gain?: number;
  /** Pitch shift in semitones from the patch's own note. */
  pitch?: number;
  /** Random pitch shift of up to +/- this many semitones, so repeats do not sound machine-made. */
  variance?: number;
  /** Semitone offsets from the (shifted) note, all started together: a chord, or an orchestra hit. */
  chord?: readonly number[];
}

/** The same sound is not started again within this many seconds. */
const MIN_REPEAT_SECONDS = 0.04;
const MASTER_GAIN = 0.6;

/**
 * The game's one door to sound: `audio.play("pickup")`. The AudioContext is
 * made on the first sound, which always follows a click or key press, so the
 * browser lets it start. Patches are decoded once, up front; the synth caches
 * the rendered buffers.
 */
export class GameAudio {
  private player: SynthPlayer | undefined;
  private readonly patches = new Map<SfxName, Patch>();
  private readonly lastPlayed = new Map<SfxName, number>();
  enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
    for (const name of Object.keys(SFX) as SfxName[]) {
      const patch = decodePatch(SFX[name]);
      if (patch === null) throw new Error(`sfx "${name}" has an invalid code: ${SFX[name]}`);
      this.patches.set(name, patch);
    }
  }

  play(name: SfxName, options: PlayOptions = {}): void {
    if (!this.enabled) return;
    const patch = this.patches.get(name);
    if (patch === undefined) return;
    const gain = options.gain ?? 1;
    if (gain <= 0.001) return;

    const player = this.ensurePlayer();
    if (player === undefined) return;
    const now = player.ctx.currentTime;
    const last = this.lastPlayed.get(name);
    if (last !== undefined && now - last < MIN_REPEAT_SECONDS) return;
    this.lastPlayed.set(name, now);

    let shift = options.pitch ?? 0;
    if (options.variance !== undefined) shift += (Math.random() * 2 - 1) * options.variance;
    // Quantised to a quarter tone: the synth caches one buffer per note, and a
    // continuous spread would render a new one on every footstep.
    const note = shift === 0 ? undefined : patch.note + Math.round(shift * 4) / 4;
    try {
      const chord = options.chord;
      if (chord === undefined || chord.length === 0) {
        player.play(patch, note === undefined ? undefined : clampNote(note), undefined, gain);
      } else {
        // Voices add up, so each takes a share: the stack is about as loud as one sound.
        const share = gain / Math.sqrt(chord.length);
        for (const offset of chord) player.play(patch, clampNote((note ?? patch.note) + offset), undefined, share);
      }
    } catch {
      // A sound that cannot play is not worth stopping the game for.
    }
  }

  private ensurePlayer(): SynthPlayer | undefined {
    if (this.player !== undefined) return this.player;
    try {
      this.player = new SynthPlayer();
      this.player.bus.gain.value = MASTER_GAIN;
    } catch {
      this.enabled = false;
    }
    return this.player;
  }
}

function clampNote(note: number): number {
  return Math.min(127, Math.max(0, note));
}
