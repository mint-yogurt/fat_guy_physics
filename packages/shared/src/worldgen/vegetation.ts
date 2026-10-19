import { CHUNK_SIZE } from "../sim/constants.ts";
import { hashFloat } from "../rng/hash.ts";
import { floorDiv } from "../voxel/voxel.ts";
import { speciesForPlacement, treeHashAt, TreeSpecies } from "./trees.ts";
import type { TerrainGenerator } from "./terrainGenerator.ts";

/**
 * Deterministic vegetation scatter, keyed off (world column, seed) so a
 * chunk that streams out and back in regenerates the same forest.
 *
 * One candidate point per chunk column (3.2m), jittered inside it, same as
 * src/voxel/Vegetation.cpp -- smaller cells cluster, and merged canopies at
 * head height are what made the native build's forests unreadable.
 *
 * The chance is roughly half the C++'s 0.12. At 0.12 the trees were dense
 * enough to be a wall; this leaves gaps you can see and walk through, which
 * is what the roadmap's "too plentiful" note was asking for.
 */
const TREE_CHANCE = 0.055;
const BUSH_CHANCE = 0.1;

export interface TreePlacement {
  /** Stable identity across streaming: the placement hash. */
  readonly id: number;
  readonly species: TreeSpecies;
  readonly rootVoxelX: number;
  readonly rootVoxelY: number;
  readonly rootVoxelZ: number;
}

/**
 * Fills `out` with the vegetation one chunk owns.
 *
 * Every vertical layer of a column is loaded at once, so without a
 * tie-breaker each layer would spawn its own copy of the same tree. A
 * column's vegetation belongs to the single layer whose Y range contains
 * that column's surface voxel; every other layer skips it.
 *
 * Roots land on the voxel lattice rather than at a fractional position (the
 * C++ offsets them by half a voxel). Sharing the terrain's lattice is what
 * lets one DDA raycast serve terrain and trees both, and what will let M8
 * treat a standing tree as collidable without a second code path.
 */
export function placeVegetation(
  generator: TerrainGenerator,
  cx: number,
  cy: number,
  cz: number,
  seed: number,
  out: TreePlacement[],
): TreePlacement[] {
  out.length = 0;

  const cellX = cx * CHUNK_SIZE;
  const cellZ = cz * CHUNK_SIZE;

  const jitterX = hashFloat(cellX, cellZ, seed, 0);
  const jitterZ = hashFloat(cellX, cellZ, seed, 1);
  const worldX = cellX + Math.min(CHUNK_SIZE - 1, Math.floor(jitterX * CHUNK_SIZE));
  const worldZ = cellZ + Math.min(CHUNK_SIZE - 1, Math.floor(jitterZ * CHUNK_SIZE));

  const surface = generator.surfaceHeight(worldX, worldZ);
  if (floorDiv(surface, CHUNK_SIZE) !== cy) return out;

  const roll = hashFloat(worldX, worldZ, seed, 2);
  if (roll >= TREE_CHANCE + BUSH_CHANCE) return out;

  const id = treeHashAt(worldX, worldZ, seed);
  out.push({
    id,
    species: roll < TREE_CHANCE ? speciesForPlacement(id) : TreeSpecies.Bush,
    rootVoxelX: worldX,
    rootVoxelY: surface,
    rootVoxelZ: worldZ,
  });
  return out;
}
