import { CHUNK_SIZE, VOXEL_SIZE } from "../sim/constants.ts";
import { hashFloat } from "../rng/hash.ts";
import { Biome, unpackBiome } from "../voxel/biomeTint.ts";
import { floorDiv } from "../voxel/voxel.ts";
import {
  BIOME_SHEET,
  DROP_CHANCE,
  GRAVE_SHEET,
  OBJECT_SHEET,
  SPAWN_CHANCE,
  type LootEntry,
  type SpawnKind,
  type TreeKind,
} from "./generationSheet.ts";
import {
  GRAVE_BOX,
  isPropKind,
  PROP_METRICS,
  TOMBSTONE_GAP,
  TOMBSTONE_HALF_THICKNESS,
  type PropKind,
} from "./props.ts";
import type { TerrainGenerator } from "./terrainGenerator.ts";
import { treeHashAt, TreeSpecies } from "./trees.ts";

/**
 * Deterministic scatter, keyed off (world column, seed) so a chunk that
 * streams out and back in regenerates the same world.
 *
 * One candidate point per chunk column (3.2 m), jittered inside it -- smaller
 * cells cluster, and merged canopies at head height are what made the native
 * build's forests unreadable. The candidate rolls once against its region's
 * list in generationSheet.ts and becomes at most one thing (a grave is one
 * thing that brings its tombstone with it).
 *
 * This runs in two places that must agree to the voxel: World, to put the
 * objects in the scene, and the terrain generator, which cuts the pits that
 * open graves sit in. Both call {@link placeCell}.
 */

const TREE_SPECIES: Readonly<Record<TreeKind, TreeSpecies>> = {
  conifer: TreeSpecies.Conifer,
  broadleaf: TreeSpecies.Broadleaf,
  dead_tree: TreeSpecies.Dead,
};

export interface TreePlacement {
  readonly type: "tree";
  /** Stable identity across streaming: the placement hash. */
  readonly id: number;
  readonly species: TreeSpecies;
  /** Which region placed it. A Halloween broadleaf is drawn in autumn colours. */
  readonly biome: Biome;
  readonly rootVoxelX: number;
  readonly rootVoxelY: number;
  readonly rootVoxelZ: number;
}

export interface BushPlacement {
  readonly type: "bush";
  readonly id: number;
  readonly rootVoxelX: number;
  readonly rootVoxelY: number;
  readonly rootVoxelZ: number;
  readonly sizeMeters: number;
}

export interface PropPlacement {
  readonly type: "prop";
  readonly id: number;
  readonly kind: PropKind;
  readonly biome: Biome;
  /** World metres; y is the ground under the prop's centre. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Authored units to metres. */
  readonly scale: number;
  readonly yaw: number;
  /**
   * Lean about the prop's own X and Z, radians. At most one is non-zero:
   * graves lean toward one of their four sides.
   */
  readonly tiltX: number;
  readonly tiltZ: number;
  /** Graves only: covered with topsoil, or open. */
  readonly topsoil: boolean;
  /** Item names inside. Empty unless the sheet puts something in. */
  readonly loot: readonly string[];
}

export type Placement = TreePlacement | BushPlacement | PropPlacement;

interface SpawnTable {
  readonly kinds: readonly SpawnKind[];
  /** Running total of SPAWN_CHANCE, parallel to `kinds`. */
  readonly cumulative: readonly number[];
}

function buildTable(biome: Biome): SpawnTable {
  const kinds: SpawnKind[] = [];
  const cumulative: number[] = [];
  let total = 0;
  for (const entry of BIOME_SHEET[biome].spawns) {
    total += SPAWN_CHANCE[entry.rarity];
    kinds.push(entry.kind);
    cumulative.push(total);
  }
  if (total > 1) throw new Error(`generation sheet: ${BIOME_SHEET[biome].label} spawns sum to ${String(total)}`);
  return { kinds, cumulative };
}

const TABLES: Readonly<Record<Biome, SpawnTable>> = {
  [Biome.Plain]: buildTable(Biome.Plain),
  [Biome.Christmas]: buildTable(Biome.Christmas),
  [Biome.Halloween]: buildTable(Biome.Halloween),
};

/** Rolls at or above this are empty in every region, so the cheap exit is shared. */
const MAX_TOTAL = Math.max(
  ...Object.values(TABLES).map((t) => t.cumulative[t.cumulative.length - 1] ?? 0),
);

function pick(table: SpawnTable, roll: number): SpawnKind | undefined {
  for (let i = 0; i < table.cumulative.length; i++) {
    if (roll < (table.cumulative[i] as number)) return table.kinds[i];
  }
  return undefined;
}

/**
 * Greatest height difference, in voxels, between a column and four points
 * `radiusVoxels` around it. A cheap stand-in for "is the ground under this
 * footprint flat".
 */
function relief(generator: TerrainGenerator, x: number, z: number, radiusVoxels: number): number {
  const centre = generator.surfaceHeight(x, z);
  let worst = 0;
  const probe = (px: number, pz: number): void => {
    worst = Math.max(worst, Math.abs(generator.surfaceHeight(px, pz) - centre));
  };
  probe(x + radiusVoxels, z);
  probe(x - radiusVoxels, z);
  probe(x, z + radiusVoxels);
  probe(x, z - radiusVoxels);
  return worst;
}

function rollLoot(kind: PropKind, biome: Biome, id: number): string[] {
  const section = OBJECT_SHEET[kind];
  if (section.container !== true) return [];
  const entries: readonly LootEntry[] = [...BIOME_SHEET[biome].containerLoot, ...(section.loot ?? [])];
  const found: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as LootEntry;
    if (hashFloat(id, 0x1007, i, 0) < DROP_CHANCE[entry.rarity]) found.push(entry.item);
  }
  return found;
}

function propShape(kind: PropKind, id: number): { scale: number; yaw: number } {
  const metrics = PROP_METRICS[kind];
  const jitter = 1 + (hashFloat(id, 0x51ce, 0, 0) * 2 - 1) * metrics.sizeJitter;
  return { scale: metrics.scale * jitter, yaw: hashFloat(id, 0x7a3, 0, 0) * Math.PI * 2 };
}

function placeProp(
  generator: TerrainGenerator,
  kind: PropKind,
  biome: Biome,
  id: number,
  voxelX: number,
  voxelZ: number,
  surface: number,
  out: Placement[],
): void {
  const maxSlope = OBJECT_SHEET[kind].maxSlope;
  const metrics = PROP_METRICS[kind];
  const x = (voxelX + 0.5) * VOXEL_SIZE;
  const z = (voxelZ + 0.5) * VOXEL_SIZE;
  const y = surface * VOXEL_SIZE;

  if (kind !== "grave") {
    const shape = propShape(kind, id);
    if (maxSlope !== undefined) {
      const radius = Math.max(1, Math.ceil((metrics.radius * shape.scale) / VOXEL_SIZE));
      if (relief(generator, voxelX, voxelZ, radius) > maxSlope) return;
    }
    out.push({
      type: "prop",
      id,
      kind,
      biome,
      x,
      y,
      z,
      scale: shape.scale,
      yaw: shape.yaw,
      tiltX: 0,
      tiltZ: 0,
      topsoil: false,
      loot: rollLoot(kind, biome, id),
    });
    return;
  }

  // --- a grave -----------------------------------------------------------
  const scale = PROP_METRICS.grave.scale * (1 + (hashFloat(id, 0x51ce, 0, 0) * 2 - 1) * PROP_METRICS.grave.sizeJitter);
  const hasTombstone = hashFloat(id, 0x70b, 0, 0) < GRAVE_SHEET.tombstoneChance;

  // Flat ground for the box and the tombstone beyond its head.
  const reach = (GRAVE_BOX.halfLength + TOMBSTONE_GAP + 2 * TOMBSTONE_HALF_THICKNESS.tombstone_2) * scale;
  if (maxSlope !== undefined && relief(generator, voxelX, voxelZ, Math.ceil(reach / VOXEL_SIZE)) > maxSlope) {
    return;
  }

  // Cardinal, with a few degrees of drift: nobody has straightened these.
  const yaw =
    Math.floor(hashFloat(id, 0x7a3, 0, 0) * 4) * (Math.PI / 2) +
    (hashFloat(id, 0x7a4, 0, 0) - 0.5) * 0.2;

  let tiltX = 0;
  let tiltZ = 0;
  if (hashFloat(id, 0xc00, 0, 0) < GRAVE_SHEET.crookedChance) {
    const span = GRAVE_SHEET.crookedMaxDegrees - GRAVE_SHEET.crookedMinDegrees;
    const degrees = GRAVE_SHEET.crookedMinDegrees + hashFloat(id, 0xc01, 0, 0) * span;
    const angle = (degrees * Math.PI) / 180;
    // One of the four sides: lean along the length (about Z) or across it
    // (about X), either way round.
    const side = Math.floor(hashFloat(id, 0xc02, 0, 0) * 4);
    const signed = side % 2 === 0 ? angle : -angle;
    if (side < 2) tiltZ = signed;
    else tiltX = signed;
  }

  const topsoil = hashFloat(id, 0x7050, 0, 0) < GRAVE_SHEET.topsoilChance;
  out.push({
    type: "prop",
    id,
    kind: "grave",
    biome,
    x,
    y,
    z,
    scale,
    yaw,
    tiltX,
    tiltZ,
    topsoil,
    loot: rollLoot("grave", biome, id),
  });

  if (!hasTombstone) return;
  const stone: "tombstone_1" | "tombstone_2" = hashFloat(id, 0x70c, 0, 0) < 0.5 ? "tombstone_1" : "tombstone_2";
  const stoneScale = PROP_METRICS[stone].scale * (scale / PROP_METRICS.grave.scale);
  // Just beyond the head, along the grave's own length. Local -X in the
  // grave's yaw frame; three's Y rotation maps local (lx, lz) to world
  // (lx cos + lz sin, -lx sin + lz cos).
  const back =
    (GRAVE_BOX.halfLength + TOMBSTONE_GAP) * scale + TOMBSTONE_HALF_THICKNESS[stone] * stoneScale;
  const sx = x - back * Math.cos(yaw);
  const sz = z + back * Math.sin(yaw);
  const stoneSurface = generator.surfaceHeight(Math.floor(sx / VOXEL_SIZE), Math.floor(sz / VOXEL_SIZE));
  out.push({
    type: "prop",
    id: (id ^ 0x5eed5eed) >>> 0,
    kind: stone,
    biome,
    x: sx,
    y: stoneSurface * VOXEL_SIZE,
    z: sz,
    scale: stoneScale,
    yaw,
    tiltX: 0,
    tiltZ: 0,
    topsoil: false,
    loot: [],
  });
}

/**
 * Pushes what the chunk column (cx, cz) holds onto `out`, and returns the
 * surface voxel height at its candidate point -- or -1 if it holds nothing.
 * Nothing is cleared: the caller owns `out`.
 */
export function placeCell(
  generator: TerrainGenerator,
  cx: number,
  cz: number,
  seed: number,
  out: Placement[],
): number {
  const cellX = cx * CHUNK_SIZE;
  const cellZ = cz * CHUNK_SIZE;

  const jitterX = hashFloat(cellX, cellZ, seed, 0);
  const jitterZ = hashFloat(cellX, cellZ, seed, 1);
  const worldX = cellX + Math.min(CHUNK_SIZE - 1, Math.floor(jitterX * CHUNK_SIZE));
  const worldZ = cellZ + Math.min(CHUNK_SIZE - 1, Math.floor(jitterZ * CHUNK_SIZE));

  // Most cells are empty and this is on the terrain worker's hot path (nine
  // cells per chunk), so find that out before touching any noise.
  const roll = hashFloat(worldX, worldZ, seed, 2);
  if (roll >= MAX_TOTAL) return -1;

  const biome = unpackBiome(generator.biomeField.tintAt(worldX, worldZ));
  const kind = pick(TABLES[biome], roll);
  if (kind === undefined) return -1;

  const surface = generator.surfaceHeight(worldX, worldZ);
  const id = treeHashAt(worldX, worldZ, seed);
  const before = out.length;

  if (kind === "bush") {
    out.push({
      type: "bush",
      id,
      rootVoxelX: worldX,
      rootVoxelY: surface,
      rootVoxelZ: worldZ,
      // Matches the native build's 4-8 voxel bush sprite.
      sizeMeters: (4 + hashFloat(worldX, worldZ, seed, 5) * 4) * 0.1,
    });
  } else if (isPropKind(kind)) {
    placeProp(generator, kind, biome, id, worldX, worldZ, surface, out);
  } else {
    out.push({
      type: "tree",
      id,
      species: TREE_SPECIES[kind],
      biome,
      rootVoxelX: worldX,
      rootVoxelY: surface,
      rootVoxelZ: worldZ,
    });
  }
  return out.length > before ? surface : -1;
}

/**
 * What one chunk owns.
 *
 * Every vertical layer of a column is loaded at once, so without a
 * tie-breaker each layer would spawn its own copy of the same thing. A
 * column's contents belong to the single layer whose Y range contains the
 * surface voxel at its candidate point; every other layer skips it.
 */
export function placeVegetation(
  generator: TerrainGenerator,
  cx: number,
  cy: number,
  cz: number,
  seed: number,
  out: Placement[],
): Placement[] {
  out.length = 0;
  const surface = placeCell(generator, cx, cz, seed, out);
  if (surface < 0 || floorDiv(surface, CHUNK_SIZE) !== cy) out.length = 0;
  return out;
}
