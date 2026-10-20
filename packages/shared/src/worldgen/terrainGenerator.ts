import FastNoiseLite from "fastnoise-lite";

import { CHUNK_SIZE } from "../sim/constants.ts";
import { BiomeField, createBiomeWeights, type BiomeWeights } from "./biome.ts";
import { TERRAIN } from "./generationSheet.ts";
import { carveGrave } from "./graveCarve.ts";
import { placeCell, type Placement } from "./spawns.ts";
import { Material } from "../voxel/voxel.ts";
import type { VoxelGrid } from "../voxel/voxelGrid.ts";

/**
 * Heightmap terrain generation, ported from src/voxel/TerrainGenerator.cpp.
 *
 * 2D fractal noise picks a surface height per (x,z) column; everything below
 * is solid and banded by depth, everything above is air. No caves or
 * overhangs at generation time -- excavation carves those later.
 *
 * With `biomes` off this is a deliberately faithful port of the original
 * generator, shortcomings included, so it can still be diffed against the
 * reference build: one spatial scale, ~10 m wavelength at +/-2.4 m, a
 * uniform bumpy field with no flats anywhere.
 *
 * With `biomes` on (production), the biome field takes over the shape of the
 * ground. Each region has its own height function -- rolling hills, flats
 * and cliffs, or flats/hills/tiered bluffs, all tuned in the TERRAIN section
 * of generationSheet.ts -- blended by region weight. The same field recolours
 * terrain and drives sky, light and weather. Chunks also have the pits of
 * open graves cut into them.
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

  /** Scratch for surfaceHeight and the grave search. One generator per thread. */
  private readonly weights = createBiomeWeights();
  private readonly placementScratch: Placement[] = [];

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

    const w = this.biomeField.sample(worldX, worldZ, this.weights);
    let offset = 0;
    if (w.christmas > 0) offset += w.christmas * this.christmasOffset(worldX, worldZ);
    if (w.halloween > 0) offset += w.halloween * this.halloweenOffset(worldX, worldZ);
    if (w.plain > 0) offset += w.plain * this.plainOffset(worldX, worldZ);
    return TERRAIN.baseHeight + Math.round(offset);
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

  private static materialForDepth(depthBelowSurface: number): Material {
    if (depthBelowSurface === 0) return Material.Dirt;
    if (depthBelowSurface <= 15) return Material.Gravel;
    if (depthBelowSurface <= 24) return Material.Rock;
    return Material.Granite;
  }

  /**
   * Fills `grid` (a 32-cube chunk grid) for the chunk at the given chunk
   * coordinate.
   *
   * Loop order is z-outer/x-inner over columns with the y fill innermost,
   * matching the chunk's `x + 32y + 1024z` layout: the surface height is
   * computed once per column rather than once per voxel.
   */
  generate(grid: VoxelGrid, chunkX: number, chunkY: number, chunkZ: number): void {
    const originX = chunkX * CHUNK_SIZE;
    const originY = chunkY * CHUNK_SIZE;
    const originZ = chunkZ * CHUNK_SIZE;
    const cells = grid.cells;
    const tint = grid.columnTint;

    for (let z = 0; z < CHUNK_SIZE; ++z) {
      const worldZ = originZ + z;
      for (let x = 0; x < CHUNK_SIZE; ++x) {
        const worldX = originX + x;
        const height = this.surfaceHeight(worldX, worldZ);
        const columnBase = x + CHUNK_SIZE * CHUNK_SIZE * z;

        // Per column, not per voxel: the field is a function of (x,z) only,
        // and sampling it 32 times down a column would triple generation
        // cost for an identical answer.
        if (tint !== undefined) {
          tint[x + CHUNK_SIZE * z] = this.biomes ? this.biomeField.tintAt(worldX, worldZ) : 0;
        }

        for (let y = 0; y < CHUNK_SIZE; ++y) {
          const worldY = originY + y;
          cells[columnBase + CHUNK_SIZE * y] =
            worldY >= height
              ? Material.Air
              : TerrainGenerator.materialForDepth(height - worldY - 1);
        }
      }
    }

    if (this.biomes) this.carveOpenGraves(grid, chunkX, chunkY, chunkZ);
  }

  /**
   * Digs the pits for open graves whose boxes reach into this chunk.
   *
   * The graves are found the way World finds them -- from the candidate
   * point of each chunk column -- and a grave is at most ~1.3 m across
   * against a 3.2 m column, so only the 3x3 columns around this one can
   * hold a grave that touches it. Covered graves are left as solid ground:
   * the topsoil hides the box anyway, and a hole under a mound the player
   * can walk across would be a trapdoor.
   */
  private carveOpenGraves(grid: VoxelGrid, chunkX: number, chunkY: number, chunkZ: number): void {
    const found = this.placementScratch;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        found.length = 0;
        placeCell(this, chunkX + dx, chunkZ + dz, this.seed, found);
        for (const placement of found) {
          if (placement.type !== "prop" || placement.kind !== "grave" || placement.topsoil) continue;
          carveGrave(
            grid.cells,
            chunkX * CHUNK_SIZE,
            chunkY * CHUNK_SIZE,
            chunkZ * CHUNK_SIZE,
            placement,
          );
        }
      }
    }
  }
}
