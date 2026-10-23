import { CHUNK_SIZE, VOXEL_SIZE } from "../sim/constants.ts";

/**
 * The ground: a low-poly heightfield on a square lattice. This file is the one source of
 * "how high is the ground at (x, z)" -- the mesh, the physics body, the solid test, the
 * raycast, and where trees and props are planted all read it, so none of them can disagree
 * (a tree floating above the mesh it was placed on is exactly that kind of bug).
 *
 * Heights are metres. The lattice has a vertex every `GROUND_STEP` metres, on global indices:
 * vertex (i, j) sits at (i * GROUND_STEP, j * GROUND_STEP) and its height is
 * `generator.smoothHeight` there. Between vertices the ground is two triangles per cell,
 * split along the diagonal from the (i, j) corner to the (i+1, j+1) corner. A tile (one
 * old-chunk column, `TILE_CELLS` cells a side) owns `LATTICE_SIDE`^2 vertices, sharing its
 * edge vertices with its neighbours, so tiles meet without cracks.
 *
 * Future: explosions and big impacts may carve craters. That belongs here, as an additive
 * term inside the vertex height, so everything above follows for free. Not built yet, and
 * not voxels -- voxels were an old version of this game.
 */

/** Metres between lattice vertices: eight of the old voxel units. */
export const GROUND_STEP = VOXEL_SIZE * 8;

/** Cells along a tile's edge. A tile is the footprint of one old chunk column. */
export const TILE_CELLS = CHUNK_SIZE / 8;

/** Vertices along a tile's edge, including the shared far edge. */
export const LATTICE_SIDE = TILE_CELLS + 1;

/** Metres along a tile's edge. */
export const TILE_METERS = TILE_CELLS * GROUND_STEP;

/** What the ground needs from the terrain generator: a smooth height in metres. */
export interface HeightSource {
  smoothHeight(xMeters: number, zMeters: number): number;
}

/** The lattice vertex height, rounded to float32 so a tile's stored copy and a direct read agree exactly. */
export function latticeHeight(source: HeightSource, i: number, j: number): number {
  return Math.fround(source.smoothHeight(i * GROUND_STEP, j * GROUND_STEP));
}

/** Tile index (chunk-column index) containing a world x or z. Integer maths on the lattice, so it never disagrees with it. */
export function tileOf(meters: number): number {
  return Math.floor(Math.floor(meters / GROUND_STEP) / TILE_CELLS);
}

/** Fills `out` (LATTICE_SIDE^2, row-major by z then x) with the heights of tile (cx, cz). */
export function fillLattice(source: HeightSource, cx: number, cz: number, out: Float32Array): Float32Array {
  for (let j = 0; j < LATTICE_SIDE; j++) {
    for (let i = 0; i < LATTICE_SIDE; i++) {
      out[i + LATTICE_SIDE * j] = latticeHeight(source, cx * TILE_CELLS + i, cz * TILE_CELLS + j);
    }
  }
  return out;
}

export function createLattice(): Float32Array {
  return new Float32Array(LATTICE_SIDE * LATTICE_SIDE);
}

/** Height inside a cell from its four corners and the position in it (0..1 each way). */
export function cellHeight(h00: number, h10: number, h01: number, h11: number, fx: number, fz: number): number {
  return fx >= fz ? h00 + fx * (h10 - h00) + fz * (h11 - h10) : h00 + fz * (h01 - h00) + fx * (h11 - h01);
}

/**
 * Cells along a stored lattice's edge. Most tiles are `TILE_CELLS`; a tile with an open grave
 * in it is built finer (groundMesh.ts), and every function below reads the size off the
 * lattice itself.
 */
export function latticeCells(lattice: Float32Array): number {
  return Math.round(Math.sqrt(lattice.length)) - 1;
}

/** Finds the cell holding (x, z) in tile (cx, cz)'s stored lattice: its first corner, and the position in it. */
function locate(
  lattice: Float32Array,
  cx: number,
  cz: number,
  x: number,
  z: number,
  out: { at: number; fx: number; fz: number; step: number },
): void {
  const cells = latticeCells(lattice);
  const side = cells + 1;
  const step = TILE_METERS / cells;
  const gx = (x - cx * TILE_METERS) / step;
  const gz = (z - cz * TILE_METERS) / step;
  const li = Math.min(cells - 1, Math.max(0, Math.floor(gx)));
  const lj = Math.min(cells - 1, Math.max(0, Math.floor(gz)));
  out.at = li + side * lj;
  out.fx = gx - li;
  out.fz = gz - lj;
  out.step = step;
}

const cell = { at: 0, fx: 0, fz: 0, step: GROUND_STEP };

/** Ground height at (x, z) inside tile (cx, cz)'s stored lattice. The point must be inside the tile. */
export function heightInTile(lattice: Float32Array, cx: number, cz: number, x: number, z: number): number {
  locate(lattice, cx, cz, x, z, cell);
  const side = latticeCells(lattice) + 1;
  const at = cell.at;
  return cellHeight(
    lattice[at] as number,
    lattice[at + 1] as number,
    lattice[at + side] as number,
    lattice[at + side + 1] as number,
    cell.fx,
    cell.fz,
  );
}

/** Slope inside tile (cx, cz)'s lattice; same contract as {@link heightInTile}. */
export function gradientInTile(
  lattice: Float32Array,
  cx: number,
  cz: number,
  x: number,
  z: number,
  out: { x: number; z: number },
): void {
  locate(lattice, cx, cz, x, z, cell);
  const side = latticeCells(lattice) + 1;
  const at = cell.at;
  const h00 = lattice[at] as number;
  const h10 = lattice[at + 1] as number;
  const h01 = lattice[at + side] as number;
  const h11 = lattice[at + side + 1] as number;
  if (cell.fx >= cell.fz) {
    out.x = (h10 - h00) / cell.step;
    out.z = (h11 - h10) / cell.step;
  } else {
    out.x = (h11 - h01) / cell.step;
    out.z = (h01 - h00) / cell.step;
  }
}

/**
 * Ground height at any (x, z) straight from the generator, with no stored tile: four vertex
 * reads. For planting things and for places the world has not loaded; per-frame collision
 * uses the stored lattice instead (see {@link heightInTile}).
 */
export function groundHeightDirect(source: HeightSource, x: number, z: number): number {
  const gx = x / GROUND_STEP;
  const gz = z / GROUND_STEP;
  const gi = Math.floor(gx);
  const gj = Math.floor(gz);
  return cellHeight(
    latticeHeight(source, gi, gj),
    latticeHeight(source, gi + 1, gj),
    latticeHeight(source, gi, gj + 1),
    latticeHeight(source, gi + 1, gj + 1),
    gx - gi,
    gz - gj,
  );
}
