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
 * Spawn rarity -> probability that a placement cell holds one.
 *
 * A cell is a chunk column (3.2 m square) and holds at most one thing, so
 * these are "per 10 square metres" and the entries in one region's list
 * must sum to under 1. Common is the old tree density: about one in
 * eighteen cells, which left gaps you can see and walk through.
 */
export const SPAWN_CHANCE: Readonly<Record<Rarity, number>> = {
  common: 0.055,
  uncommon: 0.02,
  rare: 0.007,
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
  | "tombstone_1"
  | "tombstone_2"
  | "grave";
export type SpawnKind = TreeKind | "bush" | PropKindName;

export interface SpawnEntry {
  readonly kind: SpawnKind;
  readonly rarity: Rarity;
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
   * Extra loot in every container (`OBJECT_SHEET[x].container`) that spawns
   * in this region -- the hook for "eggnog cartons in the Christmas
   * presents". Empty for now: containers are empty on purpose.
   */
  readonly containerLoot: readonly LootEntry[];
}

export const BIOME_SHEET: Readonly<Record<Biome, BiomeSection>> = {
  // The third region has no name yet, and no purpose beyond the terrain.
  // See README.
  [Biome.Plain]: {
    label: "plain (unnamed)",
    spawns: [
      { kind: "broadleaf", rarity: "common" },
      { kind: "bush", rarity: "common" },
    ],
    containerLoot: [],
  },

  [Biome.Christmas]: {
    label: "christmas",
    spawns: [
      { kind: "conifer", rarity: "common" },
      { kind: "bush", rarity: "common" },
      { kind: "snowman_small", rarity: "uncommon" },
      { kind: "snowman_big", rarity: "rare" },
      { kind: "present_small", rarity: "uncommon" },
      { kind: "present_big", rarity: "rare" },
    ],
    // Example of the hook, once the item exists:
    //   { item: "eggnog", rarity: "uncommon" },
    containerLoot: [],
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
    ],
    containerLoot: [],
  },
};

// --- per-object behaviour -------------------------------------------------

export interface ObjectSection {
  /** Holds loot. Gets its region's `containerLoot` plus `loot` below. */
  readonly container?: boolean;
  readonly loot?: readonly LootEntry[];
  /** What swinging at it yields. */
  readonly resources?: readonly ResourceEntry[];
  /**
   * Ground this flat or flatter, or it does not spawn: the greatest drop
   * between the centre and the edge of its footprint, in voxels. Omitted
   * means anything goes. Structures will set this tight.
   */
  readonly maxSlope?: number;
}

export const OBJECT_SHEET: Readonly<Record<PropKindName, ObjectSection>> = {
  snowman_small: { maxSlope: 6, resources: [{ item: "stick", rarity: "common", uses: 2 }] },
  snowman_big: { maxSlope: 6, resources: [{ item: "stick", rarity: "common", uses: 3 }] },
  present_small: { maxSlope: 6, container: true, loot: [] },
  present_big: { maxSlope: 6, container: true, loot: [] },
  // Some tombstones will be scrapable for zinc; add the row when the item
  // and the tool exist:
  //   resources: [{ item: "zinc", rarity: "rare", uses: 1 }]
  tombstone_1: { maxSlope: 8 },
  tombstone_2: { maxSlope: 8 },
  grave: { container: true, loot: [], maxSlope: 3 },
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
