import { Material } from "./voxel.ts";

/**
 * How a biome recolours terrain, and how that recolouring is packed into one
 * byte per column so the mesher can apply it.
 *
 * This lives in voxel/ rather than worldgen/ on purpose: the mesher consumes
 * it, and worldgen already depends on voxel/, so putting it the other way
 * round would make the dependency circular. Nothing here knows about noise
 * or where biomes come from -- it is a palette and an encoding.
 *
 * Biomes deliberately do *not* change which material is placed. DESIGN.md's
 * material list may be scrapped wholesale, so tying region identity to it
 * would mean unpicking it again later; a colour multiplier on top of the
 * existing materials is reversible in one file.
 */

export const Biome = {
  Plain: 0,
  Christmas: 1,
  Halloween: 2,
} as const;

export type Biome = (typeof Biome)[keyof typeof Biome];

export const BIOME_COUNT = 3;

/**
 * Ground colour each biome blends its terrain toward, indexed `biome * 3`.
 * Plain's entry is never read (its weight is always zero) but is present so
 * the stride arithmetic needs no special case.
 */
export const BIOME_GROUND_COLORS = new Float32Array([
  0.0, 0.0, 0.0, // Plain -- unused, terrain keeps its material colour
  0.95, 0.95, 0.97, // Christmas -- snow
  0.21, 0.18, 0.16, // Halloween -- dark brown-grey soil
]);

/**
 * Per-material susceptibility to the biome colour, indexed by material.
 *
 * Only the ground takes the full blend. Gravel takes half because it is what
 * a slope's side faces expose directly under the one-voxel Dirt skin -- at
 * zero it reads as grey stripes cutting through the snow. Everything deeper
 * than that is rock the weather never touched, and tinting it would make
 * every dug hole glow white.
 */
const TINT_STRENGTH = new Float32Array(16);
TINT_STRENGTH[Material.Dirt] = 1;
TINT_STRENGTH[Material.Gravel] = 0.5;
TINT_STRENGTH[Material.Sand] = 1;
TINT_STRENGTH[Material.Clay] = 0.7;

export function biomeTintStrength(material: Material): number {
  return TINT_STRENGTH[material] as number;
}

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
