import FastNoiseLite from "fastnoise-lite";

import { VOXEL_SIZE } from "../sim/constants.ts";
import { BiomeField, createBiomeWeights, type BiomeWeights } from "./biome.ts";
import { GROUND, TERRAIN } from "./generationSheet.ts";
import { groundHeightDirect } from "./groundField.ts";

/**
 * Heightmap terrain generation, ported from src/voxel/TerrainGenerator.cpp.
 *
 * 2D fractal noise picks a ground height per (x,z). The ground is no longer voxels: this is
 * the height function the ground lattice samples (groundField.ts), with `surfaceHeight` the
 * old whole-voxel version, kept because placement still measures slope in it and the C++
 * golden data tests it.
 *
 * With `biomes` off this is a deliberately faithful port of the original
 * generator, shortcomings included, so it can still be diffed against the
 * reference build: one spatial scale, ~10 m wavelength at +/-2.4 m, a
 * uniform bumpy field with no flats anywhere.
 *
 * With `biomes` on (production), the biome field takes over the shape of the
 * ground. Each region has its own height function -- rolling hills, flats
 * and cliffs, or flats/hills/tiered bluffs, all tuned in the TERRAIN section
 * of generationSheet.ts -- blended by region weight. The same field retextures
 * the ground and drives sky, light and weather.
 *
 * The `fastnoise-lite` npm package is the official JS port of the same
 * FastNoiseLite header the C++ uses. Substituting a different noise
 * implementation would silently change the entire world and destroy the
 * ability to diff against the reference build.
 */

const BASE_HEIGHT = 64;
const AMPLITUDE = 24;

/**
 * Perlin fBm of two octaves has 95% of its values inside +/-0.38 (measured),
 * so dividing by this puts "a typical extreme" at about 1. Heights are
 * written as amplitudes in the sheet, and this is what makes them mean it.
 */
const NOISE_UNIT = 0.38;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Normalised noise, clamped so a rare outlier cannot exceed the sheet's range. */
function unit(n: number): number {
  return Math.max(-1.5, Math.min(1.5, n / NOISE_UNIT));
}

function makeNoise(seed: number, salt: number, frequency: number, octaves: number): FastNoiseLite {
  const noise = new FastNoiseLite();
  noise.SetSeed(seed + salt);
  noise.SetNoiseType(FastNoiseLite.NoiseType.Perlin);
  if (octaves > 1) {
    noise.SetFractalType(FastNoiseLite.FractalType.FBm);
    noise.SetFractalOctaves(octaves);
  }
  noise.SetFrequency(frequency);
  return noise;
}

export class TerrainGenerator {
  private readonly noise: FastNoiseLite;
  readonly biomeField: BiomeField;

  // Height fields, one set per region. Separate noise objects rather than
  // one re-pointed between frequencies: they are read-only after
  // construction, which is what lets a worker share nothing.
  private readonly christmasHills: FastNoiseLite;
  private readonly christmasDetail: FastNoiseLite;
  private readonly flats: FastNoiseLite;
  private readonly cliffMask: FastNoiseLite;
  private readonly cliffWarp: FastNoiseLite;
  private readonly cliffScale: FastNoiseLite;
  private readonly plainStyle: FastNoiseLite;
  private readonly plainHills: FastNoiseLite;
  private readonly bluffMask: FastNoiseLite;
  /** Where the ground is dirt instead of grass. */
  private readonly dirtPatches: FastNoiseLite;

  /** Scratch for surfaceHeight and the grave search. One generator per thread. */
  private readonly weights = createBiomeWeights();

  /**
   * `biomes` exists for the golden-data tests, which assert vertex buffers
   * recorded from the C++ reference -- and the reference has no biomes, so
   * its colours and heights are the untinted, unshaped ones. Production
   * always leaves it on.
   */
  constructor(
    readonly seed: number,
    private readonly biomes = true,
  ) {
    this.biomeField = new BiomeField(seed);
    this.noise = new FastNoiseLite();
    this.noise.SetSeed(seed);
    this.noise.SetNoiseType(FastNoiseLite.NoiseType.Perlin);
    this.noise.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.noise.SetFractalOctaves(4);
    this.noise.SetFrequency(0.01);

    this.christmasHills = makeNoise(seed, 0x101, TERRAIN.christmas.hillFrequency, 2);
    this.christmasDetail = makeNoise(seed, 0x102, TERRAIN.christmas.detailFrequency, 1);
    this.flats = makeNoise(seed, 0x201, TERRAIN.halloween.flatFrequency, 2);
    this.cliffMask = makeNoise(seed, 0x202, TERRAIN.halloween.cliffMaskFrequency, 2);
    this.cliffWarp = makeNoise(seed, 0x203, 0.02, 1);
    this.cliffScale = makeNoise(seed, 0x204, 0.002, 1);
    this.plainStyle = makeNoise(seed, 0x301, TERRAIN.plain.styleFrequency, 2);
    this.plainHills = makeNoise(seed, 0x302, TERRAIN.plain.hillFrequency, 2);
    this.bluffMask = makeNoise(seed, 0x303, TERRAIN.plain.bluffMaskFrequency, 2);
    this.dirtPatches = makeNoise(seed, 0x401, GROUND.dirtFrequency, 2);
  }

  /**
   * Surface height in voxel units (world Y = height * VOXEL_SIZE) for a
   * voxel-grid column.
   *
   * With `biomes` off this is the original single-scale field, exactly.
   * With it on, height is the base level plus each region's own shape,
   * weighted by how much of the region the column is, so the shapes fade
   * into one another across the same band the ground colour does.
   *
   * `Math.trunc` rather than `Math.floor` in the legacy path: the C++ casts
   * a float to int, which truncates toward zero. The two differ for negative
   * values, and the noise term is negative for roughly half the world.
   */
  surfaceHeight(worldX: number, worldZ: number): number {
    if (!this.biomes) {
      const n = this.noise.GetNoise(worldX, worldZ);
      return BASE_HEIGHT + Math.trunc(n * AMPLITUDE);
    }
    return TERRAIN.baseHeight + Math.round(this.offsetVoxels(worldX, worldZ));
  }

  /** Height above `baseHeight` in voxel units, unrounded: the biome-weighted blend of the regions' shapes. */
  private offsetVoxels(worldX: number, worldZ: number): number {
    const w = this.biomeField.sample(worldX, worldZ, this.weights);
    let offset = 0;
    if (w.christmas > 0) offset += w.christmas * this.christmasOffset(worldX, worldZ);
    if (w.halloween > 0) offset += w.halloween * this.halloweenOffset(worldX, worldZ);
    if (w.plain > 0) offset += w.plain * this.plainOffset(worldX, worldZ);
    return offset;
  }

  /**
   * The ground's height in metres at a world position in metres, smooth: the same field as
   * {@link surfaceHeight} without the rounding to whole voxels. The ground lattice
   * (groundField.ts) samples this at its vertices.
   */
  smoothHeight(xMeters: number, zMeters: number): number {
    const vx = xMeters / VOXEL_SIZE;
    const vz = zMeters / VOXEL_SIZE;
    if (!this.biomes) return (BASE_HEIGHT + this.noise.GetNoise(vx, vz) * AMPLITUDE) * VOXEL_SIZE;
    return (TERRAIN.baseHeight + this.offsetVoxels(vx, vz)) * VOXEL_SIZE;
  }

  /**
   * Where the mesh really is at (x, z), in metres: the lattice's triangles, not the smooth
   * field. This is what anything planted on the ground should stand on.
   */
  groundHeight(xMeters: number, zMeters: number): number {
    return groundHeightDirect(this, xMeters, zMeters);
  }

  /** 0 = grass, 1 = dirt, from a slow noise field; slope is added by the caller. */
  dirtPatch(xMeters: number, zMeters: number): number {
    const n = this.dirtPatches.GetNoise(xMeters / VOXEL_SIZE, zMeters / VOXEL_SIZE);
    return smoothstep(GROUND.dirtThreshold - GROUND.dirtEdge, GROUND.dirtThreshold + GROUND.dirtEdge, n);
  }

  /** Gentle rolling hills, barely roughened. */
  private christmasOffset(x: number, z: number): number {
    const c = TERRAIN.christmas;
    return (
      unit(this.christmasHills.GetNoise(x, z)) * c.hillAmplitude +
      this.christmasDetail.GetNoise(x, z) * c.detailAmplitude
    );
  }

  /** Flat ground, with plateaus whose edges are cliffs. */
  private halloweenOffset(x: number, z: number): number {
    const h = TERRAIN.halloween;
    const flat = unit(this.flats.GetNoise(x, z)) * h.flatAmplitude;

    // The warp shifts where the mask crosses its threshold, so an edge is
    // ragged along its length instead of following a smooth contour.
    const mask = this.cliffMask.GetNoise(x, z) + this.cliffWarp.GetNoise(x, z) * h.cliffRoughness;
    const plateau = smoothstep(h.cliffThreshold - h.cliffEdge, h.cliffThreshold + h.cliffEdge, mask);
    if (plateau === 0) return flat;

    const variance = Math.max(-1, Math.min(1, this.cliffScale.GetNoise(x, z) * 2));
    return flat + plateau * h.cliffHeight * (1 + h.cliffHeightVariance * variance);
  }

  /** Flat, hilly or bluffs, depending on where in the region you are. */
  private plainOffset(x: number, z: number): number {
    const p = TERRAIN.plain;
    const style = this.plainStyle.GetNoise(x, z);
    const bluff = smoothstep(p.bluffAbove - p.styleBlend, p.bluffAbove + p.styleBlend, style);
    const flat = 1 - smoothstep(p.flatBelow - p.styleBlend, p.flatBelow + p.styleBlend, style);
    const hilly = Math.max(0, 1 - bluff - flat);

    let offset = 0;
    if (flat > 0) offset += flat * unit(this.flats.GetNoise(x, z)) * p.flatAmplitude;
    if (hilly > 0) offset += hilly * unit(this.plainHills.GetNoise(x, z)) * p.hillAmplitude;
    if (bluff > 0) offset += bluff * this.bluffOffset(x, z);
    return offset;
  }

  /** Stacked terraces with narrow risers, and a rounded top on the summit. */
  private bluffOffset(x: number, z: number): number {
    const p = TERRAIN.plain;
    const mask = this.bluffMask.GetNoise(x, z);
    let height = 0;
    for (const threshold of p.tierThresholds) {
      height += smoothstep(threshold - p.tierEdge, threshold + p.tierEdge, mask) * p.tierHeight;
    }
    const last = p.tierThresholds[p.tierThresholds.length - 1] ?? 0;
    return height + smoothstep(last, last + 0.15, mask) * p.domeHeight;
  }

  /** Biome blend weights at a voxel column, written into `out`. */
  biomeAt(worldX: number, worldZ: number, out: BiomeWeights): BiomeWeights {
    if (!this.biomes) {
      out.plain = 1;
      out.christmas = 0;
      out.halloween = 0;
      return out;
    }
    return this.biomeField.sample(worldX, worldZ, out);
  }
}
