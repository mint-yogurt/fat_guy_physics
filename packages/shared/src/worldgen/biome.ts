import FastNoiseLite from "fastnoise-lite";

import { Biome, packBiomeTint } from "../voxel/biomeTint.ts";

/**
 * The biome field: which holiday region a world column belongs to.
 *
 * One low-frequency noise channel, thresholded at both ends. Christmas sits
 * in the high tail, Halloween in the low tail, and the broad middle is
 * untouched "plain" terrain, so the two themed regions are islands in
 * ordinary ground rather than a checkerboard meeting along a seam. That also
 * means adding a third region later is two more thresholds, not a rewrite.
 *
 * Transitions are weight-blended across the threshold band rather than
 * switching at a line, which is what DESIGN.md asks for ("blend gradually
 * using noise rather than abrupt borders"). The weight is the only thing
 * biomes currently drive -- ground colour, sky, light and weather all read
 * it, and nothing changes which material is placed.
 */

/**
 * Noise frequency in *voxel* units, so a wavelength of 1/f voxels is 0.1/f
 * metres. 0.0005 gives ~200m regions: big enough to be somewhere you are
 * rather than something you pass through, small enough that spawn is not a
 * ten-minute walk from the nearest themed region.
 */
const BIOME_FREQUENCY = 0.0005;

/**
 * Offsets the biome field's seed from the terrain's. Sharing a seed would
 * correlate region boundaries with the heightmap, putting every Christmas
 * region on the same side of every hill.
 */
const BIOME_SEED_OFFSET = 0x5eed;

/** Where each region starts and reaches full strength, in noise units. */
const BAND_START = 0.18;
const BAND_FULL = 0.4;

/** Smooth 0..1 ramp. Hermite, matching GLSL smoothstep. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How much of each biome a column is. Mutated in place by
 * {@link BiomeField.sample} -- the client samples this every frame to drive
 * the sky and the weather, which is not somewhere to be allocating.
 */
export interface BiomeWeights {
  plain: number;
  christmas: number;
  halloween: number;
}

export function createBiomeWeights(): BiomeWeights {
  return { plain: 1, christmas: 0, halloween: 0 };
}

export class BiomeField {
  private readonly noise: FastNoiseLite;

  constructor(seed: number) {
    this.noise = new FastNoiseLite();
    this.noise.SetSeed(seed + BIOME_SEED_OFFSET);
    this.noise.SetNoiseType(FastNoiseLite.NoiseType.Perlin);
    this.noise.SetFractalType(FastNoiseLite.FractalType.FBm);
    // Two octaves, not four: the point of this field is large smooth
    // regions, and the fine octaves of a 4-octave fBm only serve to make
    // the border wander in a way that reads as noise rather than as coast.
    this.noise.SetFractalOctaves(2);
    this.noise.SetFrequency(BIOME_FREQUENCY);
  }

  /** Raw field value, roughly -1..1. */
  private field(worldX: number, worldZ: number): number {
    return this.noise.GetNoise(worldX, worldZ);
  }

  /** Fills `out` with the blend weights at a voxel column. */
  sample(worldX: number, worldZ: number, out: BiomeWeights): BiomeWeights {
    const n = this.field(worldX, worldZ);
    const christmas = smoothstep(BAND_START, BAND_FULL, n);
    const halloween = smoothstep(-BAND_START, -BAND_FULL, n);
    out.christmas = christmas;
    out.halloween = halloween;
    out.plain = Math.max(0, 1 - christmas - halloween);
    return out;
  }

  /**
   * The dominant biome and its weight, packed for the mesher.
   *
   * Only one biome can be non-zero at a time given the bands are on opposite
   * tails, so "dominant" is exact rather than an approximation.
   */
  tintAt(worldX: number, worldZ: number): number {
    const n = this.field(worldX, worldZ);
    if (n >= BAND_START) {
      return packBiomeTint(Biome.Christmas, smoothstep(BAND_START, BAND_FULL, n));
    }
    if (n <= -BAND_START) {
      return packBiomeTint(Biome.Halloween, smoothstep(-BAND_START, -BAND_FULL, n));
    }
    return 0;
  }
}
