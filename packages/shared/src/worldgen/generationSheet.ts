import { Biome } from "../voxel/biomeTint.ts";

/**
 * The generation control sheet.
 *
 * Everything a designer would want to turn lives in this one file: how hilly
 * each region is, what spawns in it and how often, and what can be got out
 * of the things that spawn. The code that reads it (terrainGenerator.ts,
 * spawns.ts, world.ts) has no numbers of its own about any of this, so
 * "make presents rarer in the snow" or "put eggnog in them" is an edit here
 * and nothing else.
 *
 * Three kinds of tuning, three sections:
 *
 *  - `TERRAIN`: heights, per region. Voxel units (1 voxel = 10 cm).
 *  - `BIOME_SHEET`: what spawns in each region, by rarity word.
 *  - `OBJECT_SHEET`: per-object behaviour -- what can be harvested from it,
 *    what a container holds, how a grave is dressed.
 *
 * Adding a thing: give it a kind (props.ts for a mesh, below for a tree),
 * list it under whichever regions it appears in, and give it a row in
 * OBJECT_SHEET if anything can be got from it.
 */

/** How often something turns up. Three words, so tuning is a one-word edit. */
export type Rarity = "common" | "uncommon" | "rare";

/**
 * What a spawn entry can be rarer than `rare`: a `structure` is a landmark
 * (a gingerbread house), found a few to a region rather than scattered.
 */
export type SpawnRarity = Rarity | "structure";

/**
 * Spawn rarity -> probability that a placement cell holds one.
 *
 * A cell is a chunk column (3.2 m square) and holds at most one thing, so
 * these are "per 10 square metres" and the entries in one region's list
 * must sum to under 1. Common is the old tree density: about one in
 * eighteen cells, which left gaps you can see and walk through.
 *
 * `structure` is one cell in eleven hundred; the slope and clearance checks
 * that a structure must pass (see spawns.ts) turn away close to half of
 * those, which leaves about one per 20,000 m². Christmas regions run from a
 * few hundred m² to 85,000 (median 8,000), so a typical one has none or one,
 * a big one two or three, and a small one none: the bigger the region, the
 * likelier it has a house. (Sizes measured on seed
 * 1337 over 3 km x 3 km; another seed will differ a little.)
 */
export const SPAWN_CHANCE: Readonly<Record<SpawnRarity, number>> = {
  common: 0.055,
  uncommon: 0.02,
  rare: 0.007,
  structure: 0.0009,
};

/**
 * Drop rarity -> probability a harvest swing yields the item. Separate from
 * SPAWN_CHANCE because "rare to find" and "rare to get" are different dials
 * with very different sensible values.
 */
export const DROP_CHANCE: Readonly<Record<Rarity, number>> = {
  common: 0.6,
  uncommon: 0.3,
  rare: 0.1,
};

// --- what can spawn -------------------------------------------------------

export type TreeKind = "conifer" | "broadleaf" | "dead_tree";
export type PropKindName =
  | "snowman_small"
  | "snowman_big"
  | "present_small"
  | "present_big"
  | "bucket_candy"
  | "tombstone_1"
  | "tombstone_2"
  | "grave"
  | "leafpile"
  | "snowbank"
  | "rock"
  | "gbreadhouse_1";
export type SpawnKind = TreeKind | "bush" | PropKindName;

export interface SpawnEntry {
  readonly kind: SpawnKind;
  readonly rarity: SpawnRarity;
}

/**
 * An item that can come out of something. `item` is an item *name* (see
 * ITEM_NAMES in items/inventory.ts); a name with no item behind it yet is
 * carried along harmlessly, so a row can be written before the item exists.
 */
export interface LootEntry {
  readonly item: string;
  readonly rarity: Rarity;
}

/** Something a player can repeatedly knock out of an object. */
export interface ResourceEntry {
  readonly item: string;
  /** Chance per swing. */
  readonly rarity: Rarity;
  /** How many times in total this object gives it up. */
  readonly uses: number;
  /** How many come out each time it does; omitted means one. */
  readonly amount?: number;
}

// --- terrain --------------------------------------------------------------

/**
 * Terrain shape per region. Heights are voxels above `baseHeight`;
 * frequencies are noise cycles per voxel (so 0.004 is a 25 m wavelength).
 * Noise inputs are normalised to roughly -1..1 before being scaled.
 *
 * The region field blends these by weight, so a region's character fades in
 * across the same ~20 m band its ground colour does.
 *
 * Steepness is the lever for "can the player walk up it". The walking
 * collider steps up 0.51 m, so any face that rises more than about five
 * voxels per voxel of run is a wall. Cliff and tier edges are set narrow
 * enough to be walls; `edge` is a width in raw noise units, and the run it
 * makes is about edge / 0.003 voxels.
 */
export const TERRAIN = {
  /** Mean ground level, voxels. 64 voxels is 6.4 m. */
  baseHeight: 64,

  /** Relatively flat, with gentle rolling picturesque hills. */
  christmas: {
    hillAmplitude: 14, // 1.4 m
    hillFrequency: 0.0035, // ~29 m between crests
    detailAmplitude: 1.2, // knocks the hills' smoothness off, barely
    detailFrequency: 0.03,
  },

  /** Flatter sections, with cliffs that jut out of them. */
  halloween: {
    flatAmplitude: 4,
    flatFrequency: 0.003,
    /** Where the cliff mask turns plateau on; higher is rarer. ~25% of the region at 0.15. */
    cliffThreshold: 0.15,
    cliffMaskFrequency: 0.004,
    /** Narrow, so the face is a wall (see above). */
    cliffEdge: 0.004,
    cliffHeight: 40, // 4 m
    /** 0.4 means cliff heights range over 60%..140% of cliffHeight. */
    cliffHeightVariance: 0.4,
    /** How far the edge wanders, in mask units: jagged rather than contoured. */
    cliffRoughness: 0.02,
  },

  /**
   * Third region. A slow "style" field decides, place by place, whether the
   * ground is flat, gently hilly, or a field of big rounded tiered bluffs.
   */
  plain: {
    styleFrequency: 0.0012, // ~80 m patches of one style
    /** Style values below/above these are flat/bluffs; hills in between. */
    flatBelow: -0.1,
    bluffAbove: 0.14,
    styleBlend: 0.06,
    flatAmplitude: 3,
    hillAmplitude: 22, // 2.2 m
    hillFrequency: 0.006,
    bluffMaskFrequency: 0.003,
    /** Mask values at which each tier begins. Three tiers, three numbers. */
    tierThresholds: [0.06, 0.16, 0.26],
    tierEdge: 0.0035,
    tierHeight: 28, // 2.8 m per tier, 8.4 m for a full bluff
    /** Extra rounding on top, so a summit is a dome and not a slab. */
    domeHeight: 8,
  },
} as const;

// --- per-region spawns ----------------------------------------------------

export interface BiomeSection {
  /** For the HUD and for people. */
  readonly label: string;
  readonly spawns: readonly SpawnEntry[];
  /**
   * The region's loot table: what turns up inside things that spawn there.
   * Every container (`OBJECT_SHEET[x].container`) gets each entry at its drop
   * rarity (see DROP_CHANCE), on top of its own `loot` row; and a structure's
   * one item (`OBJECT_SHEET[x].interior`) is drawn from it, weighted by those
   * same rarities. A name with no item behind it yet is carried along and
   * skipped, so a table can list items ahead of time.
   */
  readonly lootTable: readonly LootEntry[];
}

export const BIOME_SHEET: Readonly<Record<Biome, BiomeSection>> = {
  // The third region has no name yet, and no purpose beyond the terrain.
  // See README.
  [Biome.Plain]: {
    label: "plain (unnamed)",
    spawns: [
      { kind: "broadleaf", rarity: "common" },
      { kind: "bush", rarity: "common" },
      // Lying about; it is a physical thing (items/rock.ts), shoved, roped, carried.
      { kind: "rock", rarity: "uncommon" },
    ],
    lootTable: [],
  },

  [Biome.Christmas]: {
    label: "christmas",
    spawns: [
      { kind: "conifer", rarity: "common" },
      { kind: "bush", rarity: "common" },
      { kind: "snowman_small", rarity: "uncommon" },
      { kind: "snowman_big", rarity: "rare" },
      // Containers (OBJECT_SHEET `grid`): rare finds, stocked from the loot table below.
      { kind: "present_small", rarity: "rare" },
      { kind: "present_big", rarity: "rare" },
      // Scatter: scoop or chup it for snow.
      { kind: "snowbank", rarity: "common" },
      // A landmark: break into it for the item (and maybe a present) inside.
      { kind: "gbreadhouse_1", rarity: "structure" },
    ],
    // Christmas loot: in every present and gift here, and one item per
    // gingerbread house.
    lootTable: [
      { item: "xmas_lights", rarity: "uncommon" },
      { item: "mountain_lightning", rarity: "common" },
      { item: "eggnog", rarity: "rare" },
      { item: "snowball", rarity: "uncommon" },
      { item: "log", rarity: "uncommon" },
      { item: "stick", rarity: "uncommon" },
      { item: "coal", rarity: "rare" },
      { item: "metal", rarity: "rare" },
      { item: "candy", rarity: "rare" },
    ],
  },

  [Biome.Halloween]: {
    label: "halloween",
    spawns: [
      { kind: "dead_tree", rarity: "common" },
      // The living tree, recoloured autumn by the renderer.
      { kind: "broadleaf", rarity: "uncommon" },
      { kind: "bush", rarity: "uncommon" },
      { kind: "tombstone_1", rarity: "common" },
      { kind: "tombstone_2", rarity: "uncommon" },
      { kind: "grave", rarity: "common" },
      // A container, like the Christmas presents: a rare find, empty for now.
      { kind: "bucket_candy", rarity: "rare" },
      // Scatter decor: lies flat, walk-through, nothing to get from it.
      { kind: "leafpile", rarity: "common" },
      { kind: "rock", rarity: "rare" },
    ],
    lootTable: [],
  },
};

// --- per-object behaviour -------------------------------------------------

/** An item a prop gives up: `amount` of it, or between `amount` and `maxAmount` when that is given. */
export interface DropRow {
  readonly item: string;
  readonly amount: number;
  readonly maxAmount?: number;
}

/** How many a drop gives this time; `random` is a number in [0, 1). */
export function dropCount(drop: DropRow, random: number): number {
  const most = drop.maxAmount ?? drop.amount;
  return drop.amount + Math.floor(random * (most - drop.amount + 1));
}

export interface ObjectSection {
  /** Holds loot. Gets its region's `lootTable` plus `loot` below. */
  readonly container?: boolean;
  /**
   * A container the player can open, pick up when empty, and place again
   * (items/container.ts): the shape of its storage grid, in slots. Only
   * objects with a matching container item (present_small = the Present,
   * present_big = the Gift, bucket_candy) can have one.
   */
  readonly grid?: { readonly columns: number; readonly rows: number };
  readonly loot?: readonly LootEntry[];
  /** What swinging at it yields. */
  readonly resources?: readonly ResourceEntry[];
  /**
   * What it gives up when the part of it marked `releasesDrops` (props.ts
   * PROP_SECTIONS) breaks off: item name and how many. A name with no item
   * behind it yet is ignored, like loot.
   */
  readonly drops?: readonly DropRow[];
  /**
   * What is inside a structure (a gingerbread house), which comes out when it
   * is hit to pieces (`PropMetrics.breakable`). `items` are drawn from the region's `lootTable`
   * (weighted by rarity); `containerChance` is the chance that it also holds
   * one of `containers`, which is stocked from the table like any other.
   */
  readonly interior?: {
    readonly items: number;
    readonly containerChance: number;
    readonly containers: readonly PropKindName[];
  };
  /**
   * Ground this flat or flatter, or it does not spawn: the greatest drop
   * between the centre and the edge of its footprint, in voxels. Omitted
   * means anything goes. Structures will set this tight.
   */
  readonly maxSlope?: number;
}

/** One or two pieces of coal: a snowman's eyes, mouth and buttons, when its head comes off. */
const SNOWMAN_COAL: DropRow = { item: "coal", amount: 1, maxAmount: 2 };

export const OBJECT_SHEET: Readonly<Record<PropKindName, ObjectSection>> = {
  // Every snowman drops 1-2 coal when its head comes off.
  // Only the big snowman has sticks (its arms), two of them.
  snowman_small: { maxSlope: 6, drops: [SNOWMAN_COAL] },
  snowman_big: {
    maxSlope: 6,
    resources: [{ item: "stick", rarity: "common", uses: 2 }],
    drops: [SNOWMAN_COAL],
  },
  present_small: { maxSlope: 6, container: true, grid: { columns: 4, rows: 2 }, loot: [] },
  present_big: { maxSlope: 6, container: true, grid: { columns: 6, rows: 3 }, loot: [] },
  bucket_candy: { maxSlope: 6, container: true, grid: { columns: 4, rows: 3 }, loot: [] },
  // Some tombstones will be scrapable for zinc; add the row when the item
  // and the tool exist:
  //   resources: [{ item: "zinc", rarity: "rare", uses: 1 }]
  tombstone_1: { maxSlope: 8 },
  tombstone_2: { maxSlope: 8 },
  grave: { container: true, loot: [], maxSlope: 3 },
  // Four metres across and laid flat, so it needs level ground or an edge
  // hangs in the air.
  leafpile: { maxSlope: 3 },
  // A low drift, so a gentle slope is fine. Each hit that lands knocks out a
  // few snowballs; there are only so many in it.
  snowbank: { maxSlope: 5, resources: [{ item: "snowball", rarity: "common", uses: 8, amount: 3 }] },
  // A rock is not a prop once it is in the world: it is placed as a heavy ball
  // that lies still until something moves it. Not too steep, or it would not
  // look at rest.
  rock: { maxSlope: 4 },
  // A structure: tight on slope (a wall hanging in the air shows), one item from
  // the region's loot table inside, and one time in five a present or gift too.
  gbreadhouse_1: {
    maxSlope: 4,
    interior: { items: 1, containerChance: 0.2, containers: ["present_small", "present_big"] },
  },
};

/**
 * How graves are dressed. Probabilities, not rarities: these are about one
 * grave, not about the landscape.
 */
export const GRAVE_SHEET = {
  /** Covered with topsoil; the rest are open. Both can hold loot. */
  topsoilChance: 0.75,
  /** Marked by a tombstone at the x- end, facing the grave. */
  tombstoneChance: 0.85,
  /** Unmaintained: leaning, rather than square to the ground. */
  crookedChance: 0.3,
  crookedMinDegrees: 1,
  crookedMaxDegrees: 12,
} as const;

/** The foliage tint of a Halloween broadleaf, 0xRRGGBB: yellowy orange-brown. */
export const AUTUMN_FOLIAGE_COLOR = 0xc98a2b;
