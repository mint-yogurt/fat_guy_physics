import { CHUNK_SIZE, CHUNK_VOLUME } from "../sim/constants.ts";
import { Material } from "./voxel.ts";

/**
 * A rectangular grid of voxels.
 *
 * One type covers terrain chunks *and* tree/log grids. The C++ has two: a
 * fixed 32-cube `Chunk` indexed `x + y*32 + z*32*32`, and `TreeVoxelGrid`
 * indexed `(y*dz + z)*dx + x`. Two conventions for the same concept meant two
 * meshers, because ChunkMesher was hardcoded to the fixed 32-cube shape and
 * so trees fell back to a much worse per-voxel box mesher
 * (TreeVoxels.hpp:105-111). Collapsing to one convention -- the chunk's --
 * collapses those two meshers into one, which is what lets trees be
 * greedy-meshed at M6.
 *
 * `originLocal` is kept from TreeVoxelGrid: callers address cells in a local
 * coordinate space whose (0,0,0) is a meaningful anchor (a tree's trunk root,
 * a log's pivot) that need not be the grid's corner. For a chunk it is just
 * (0,0,0).
 */
export interface VoxelGrid {
  readonly dimX: number;
  readonly dimY: number;
  readonly dimZ: number;
  /** Grid index corresponding to local (0,0,0). */
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  /** Length dimX*dimY*dimZ, indexed by `gridIndex`. */
  readonly cells: Uint8Array;
}

export function gridIndex(grid: VoxelGrid, gx: number, gy: number, gz: number): number {
  return gx + grid.dimX * (gy + grid.dimY * gz);
}

export function createGrid(
  dimX: number,
  dimY: number,
  dimZ: number,
  originX = 0,
  originY = 0,
  originZ = 0,
): VoxelGrid {
  return {
    dimX,
    dimY,
    dimZ,
    originX,
    originY,
    originZ,
    cells: new Uint8Array(dimX * dimY * dimZ),
  };
}

/** A 32-cube chunk grid. Matches the C++ `Chunk`'s storage exactly. */
export function createChunkGrid(): VoxelGrid {
  return {
    dimX: CHUNK_SIZE,
    dimY: CHUNK_SIZE,
    dimZ: CHUNK_SIZE,
    originX: 0,
    originY: 0,
    originZ: 0,
    cells: new Uint8Array(CHUNK_VOLUME),
  };
}

/** Reads a cell in *local* coordinates. Out-of-bounds reads as Air. */
export function gridAt(grid: VoxelGrid, lx: number, ly: number, lz: number): Material {
  const gx = lx + grid.originX;
  const gy = ly + grid.originY;
  const gz = lz + grid.originZ;
  if (gx < 0 || gx >= grid.dimX || gy < 0 || gy >= grid.dimY || gz < 0 || gz >= grid.dimZ) {
    return Material.Air;
  }
  return grid.cells[gridIndex(grid, gx, gy, gz)] as Material;
}

/** Writes a cell in *local* coordinates. Out-of-bounds writes are dropped. */
export function gridSet(
  grid: VoxelGrid,
  lx: number,
  ly: number,
  lz: number,
  material: Material,
): void {
  const gx = lx + grid.originX;
  const gy = ly + grid.originY;
  const gz = lz + grid.originZ;
  if (gx < 0 || gx >= grid.dimX || gy < 0 || gy >= grid.dimY || gz < 0 || gz >= grid.dimZ) {
    return;
  }
  grid.cells[gridIndex(grid, gx, gy, gz)] = material;
}
