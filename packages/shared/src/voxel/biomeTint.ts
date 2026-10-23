/**
 * The three biomes, and how a (biome, weight) pair is packed into one byte (the biome field's
 * `tintAt`, which the placement code reads to pick a region's spawn table).
 */

export const Biome = {
  Plain: 0,
  Christmas: 1,
  Halloween: 2,
} as const;

export type Biome = (typeof Biome)[keyof typeof Biome];

export const BIOME_COUNT = 3;

/**
 * Weight quantisation steps. Six bits, because the top two carry the biome
 * id -- 64 steps across a transition band tens of metres wide is finer than
 * the eye can pick out, and keeping the whole thing in one byte is what lets
 * the mesher use it as part of a mask cell's identity (see below).
 */
const WEIGHT_STEPS = 63;

/**
 * Packs (biome, weight) into a byte. Plain always encodes as 0, so an
 * untinted world is a zero-filled array and the mesher's fast path is
 * "the byte is 0".
 */
export function packBiomeTint(biome: Biome, weight: number): number {
  if (biome === Biome.Plain || weight <= 0) return 0;
  const steps = Math.round(Math.min(1, weight) * WEIGHT_STEPS);
  if (steps === 0) return 0;
  return (biome << 6) | steps;
}

export function unpackBiome(tint: number): Biome {
  return (tint >> 6) as Biome;
}

export function unpackBiomeWeight(tint: number): number {
  return (tint & WEIGHT_STEPS) / WEIGHT_STEPS;
}
