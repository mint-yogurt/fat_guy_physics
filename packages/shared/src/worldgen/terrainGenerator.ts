import FastNoiseLite from "fastnoise-lite";

import { CHUNK_SIZE } from "../sim/constants.ts";
import { Material } from "../voxel/voxel.ts";
import type { VoxelGrid } from "../voxel/voxelGrid.ts";

/**
 * Heightmap terrain generation, ported from src/voxel/TerrainGenerator.cpp.
 *
 * 2D fractal noise picks a surface height per (x,z) column; everything below
 * is solid and banded by depth, everything above is air. No caves or
 * overhangs at generation time -- excavation carves those later.
 *
 * This is a deliberately faithful port of the *current* generator, including
 * its shortcomings, so the port can be diffed against the reference build.
 * The actual world-generation redesign (climate fields, weight-blended
 * biomes, a multi-scale heightmap) lands at M13. For the record of what is
 * wrong with this one: there is exactly one spatial scale, and it is small --
 * frequency 0.01 in voxel units is a ~10m wavelength at +/-2.4m amplitude, so
 * the world is a uniform bumpy field with no continents, valleys, plateaus or
 * flats anywhere.
 *
 * The `fastnoise-lite` npm package is the official JS port of the same
 * FastNoiseLite header the C++ uses. Substituting a different noise
 * implementation would silently change the entire world and destroy the
 * ability to diff against the reference build.
 */

const BASE_HEIGHT = 64;
const AMPLITUDE = 24;

export class TerrainGenerator {
  private readonly noise: FastNoiseLite;

  constructor(readonly seed: number) {
    this.noise = new FastNoiseLite();
    this.noise.SetSeed(seed);
    this.noise.SetNoiseType(FastNoiseLite.NoiseType.Perlin);
    this.noise.SetFractalType(FastNoiseLite.FractalType.FBm);
    this.noise.SetFractalOctaves(4);
    this.noise.SetFrequency(0.01);
  }

  /**
   * Surface height in voxel units (world Y = height * VOXEL_SIZE) for a
   * voxel-grid column.
   *
   * `Math.trunc` rather than `Math.floor`: the C++ casts a float to int,
   * which truncates toward zero. The two differ for negative values, and the
   * noise term is negative for roughly half the world.
   */
  surfaceHeight(worldX: number, worldZ: number): number {
    const n = this.noise.GetNoise(worldX, worldZ);
    return BASE_HEIGHT + Math.trunc(n * AMPLITUDE);
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

    for (let z = 0; z < CHUNK_SIZE; ++z) {
      const worldZ = originZ + z;
      for (let x = 0; x < CHUNK_SIZE; ++x) {
        const height = this.surfaceHeight(originX + x, worldZ);
        const columnBase = x + CHUNK_SIZE * CHUNK_SIZE * z;

        for (let y = 0; y < CHUNK_SIZE; ++y) {
          const worldY = originY + y;
          cells[columnBase + CHUNK_SIZE * y] =
            worldY >= height
              ? Material.Air
              : TerrainGenerator.materialForDepth(height - worldY - 1);
        }
      }
    }
  }
}
