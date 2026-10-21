import { hash32, hashFloat } from "../rng/hash.ts";

/**
 * Trees as authored meshes with parametric collision.
 *
 * This replaces the voxelised generator. A tree is now one of three GLBs
 * plus a handful of numbers: a uniform scale, a yaw, and the shapes that
 * stand in for it in the collision and raycast code -- a cylinder for the
 * trunk and an ellipsoid per foliage cluster.
 *
 * Nothing here knows about meshes or three.js, which is the point: the
 * client scales the authored mesh to match these numbers rather than the
 * other way round, so a tree's collision does not depend on an asset
 * having finished loading.
 *
 * The metrics below are measured off the GLBs in *authored units* with the
 * tree's base at y=0, and scaled into metres per tree. Re-measure them if
 * an artist changes a file (see the comment on TREE_METRICS).
 */

export const TreeSpecies = {
  /** tree_xmas_mid.glb -- the Christmas region. */
  Conifer: 0,
  /** tree_large.glb -- the plain region. */
  Broadleaf: 1,
  /** tree_dead_1.glb -- the Halloween region. */
  Dead: 2,
  /** Not a mesh: scattered plants are billboards (see World's sink). */
  Bush: 3,
} as const;
export type TreeSpecies = (typeof TreeSpecies)[keyof typeof TreeSpecies];

/** One foliage cluster: an on-axis ellipsoid, in authored units. */
export interface FoliageMetrics {
  /** Name of the node in the GLB, so the client can find its geometry. */
  readonly node: string;
  /** Centre height above the tree's base. */
  readonly y: number;
  /** Horizontal radius. */
  readonly radiusXZ: number;
  /** Half the vertical extent. */
  readonly radiusY: number;
}

export interface SpeciesMetrics {
  readonly asset: string;
  /** Overall height of the authored mesh, mesh units. */
  readonly authoredHeight: number;
  /**
   * What that height becomes in metres at scale 1. The authored files are
   * five to seven times game scale, and this is the one number to turn if
   * the forest wants to be taller or shorter -- everything else is derived
   * from it.
   */
  readonly targetHeightMeters: number;
  /** Top of the trunk node above the base, authored units. */
  readonly trunkTop: number;
  /**
   * A representative trunk radius, authored units: not the widest point.
   * The dead tree flares to 2.7 at the roots and the conifer's trunk is a
   * cone, and a collision cylinder built from either extreme is either a
   * tree you cannot walk up to or one you cannot hit.
   */
  readonly trunkRadius: number;
  readonly foliage: readonly FoliageMetrics[];
}

/**
 * Measured from assets/meshes with tools/measure (see the git history for
 * the throwaway script). Heights are from the bottom of the whole tree, not
 * from the mesh origin -- the files put the origin mid-trunk.
 */
export const TREE_METRICS: Readonly<Record<number, SpeciesMetrics>> = {
  [TreeSpecies.Conifer]: {
    asset: "/meshes/tree_xmas_mid.glb",
    authoredHeight: 9.84,
    targetHeightMeters: 5.5,
    trunkTop: 9.84,
    trunkRadius: 0.45,
    foliage: [
      { node: "leaves1", y: 1.73, radiusXZ: 3.64, radiusY: 1.01 },
      { node: "leaves2", y: 2.97, radiusXZ: 3.1, radiusY: 1.27 },
      { node: "leaves3", y: 4.4, radiusXZ: 1.98, radiusY: 1.03 },
      { node: "leaves4", y: 5.61, radiusXZ: 1.78, radiusY: 1.42 },
      { node: "leaves5", y: 7.03, radiusXZ: 1.14, radiusY: 1.0 },
    ],
  },
  [TreeSpecies.Broadleaf]: {
    asset: "/meshes/tree_large.glb",
    authoredHeight: 33.99,
    targetHeightMeters: 7,
    trunkTop: 20,
    trunkRadius: 1.2,
    foliage: [{ node: "leaves", y: 22.29, radiusXZ: 9.06, radiusY: 11.7 }],
  },
  [TreeSpecies.Dead]: {
    asset: "/meshes/tree_dead_1.glb",
    authoredHeight: 17.08,
    targetHeightMeters: 4.5,
    trunkTop: 17.08,
    trunkRadius: 1.1,
    // Bare on purpose: the branches are part of the trunk mesh, so they
    // are chopped with it rather than harvested as foliage.
    foliage: [],
  },
};

/** How much a tree may differ from its species' authored size. */
const SIZE_JITTER = 0.2;

/** A placed tree's dimensions, all in metres. */
export interface TreeShape {
  readonly species: TreeSpecies;
  /** Uniform scale from authored units to metres. */
  readonly scale: number;
  readonly yaw: number;
  readonly heightMeters: number;
  readonly trunkTopMeters: number;
  readonly trunkRadiusMeters: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function metricsFor(species: TreeSpecies): SpeciesMetrics | undefined {
  return TREE_METRICS[species];
}

export function treeShape(treeHash: number, species: TreeSpecies): TreeShape | undefined {
  const metrics = TREE_METRICS[species];
  if (metrics === undefined) return undefined;

  const size = lerp(1 - SIZE_JITTER, 1 + SIZE_JITTER, hashFloat(treeHash, 1, 0, 0));
  const scale = (metrics.targetHeightMeters / metrics.authoredHeight) * size;

  return {
    species,
    scale,
    yaw: hashFloat(treeHash, 2, 0, 0) * Math.PI * 2,
    heightMeters: metrics.authoredHeight * scale,
    trunkTopMeters: metrics.trunkTop * scale,
    trunkRadiusMeters: metrics.trunkRadius * scale,
  };
}

/** Chance a Christmas conifer is strung with xmas lights. */
export const TREE_LIGHTS_CHANCE = 0.25;
/** Most strings of lights on one tree. */
export const TREE_LIGHTS_MAX = 3;

/**
 * How many strings of xmas lights a Christmas conifer is hung with: none for
 * three trees in four, otherwise one to three. Decided from the tree's id
 * alone, so it is the same every time the tree streams back in.
 */
export function treeLightCount(treeHash: number): number {
  if (hashFloat(treeHash, 0x11c7, 0, 0) >= TREE_LIGHTS_CHANCE) return 0;
  return 1 + Math.min(TREE_LIGHTS_MAX - 1, Math.floor(hashFloat(treeHash, 0x11c8, 0, 0) * TREE_LIGHTS_MAX));
}

export function treeHashAt(worldVoxelX: number, worldVoxelZ: number, seed: number): number {
  // Unsigned, so an id is never negative and `>= 0` stays a valid test.
  return hash32(worldVoxelX, worldVoxelZ, seed, 3) >>> 0;
}
