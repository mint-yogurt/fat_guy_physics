/**
 * Voxel materials and the predicates that gate what can be done to them.
 * Ported from src/voxel/Voxel.hpp and src/voxel/Voxel.cpp.
 */

/**
 * Deliberately a const object rather than a TypeScript `enum`: Node's
 * type-stripping loader (which is what lets the future server consume this
 * package as plain .ts source instead of as a build artifact) rejects `enum`
 * outright, since an enum emits runtime code rather than being erasable.
 *
 * The full list is from DESIGN.md. Only a depth-based subset is placed by the
 * current heightmap generator (Dirt/Gravel/Rock/Granite); the rest are
 * reserved for biome-driven generation and excavation-hardness tiers. Wood
 * and Leaf are tree materials -- trees carry their own voxel grid rather than
 * living in the terrain chunk grid, but reuse this enum so isSolid() and
 * friends don't need a second copy of the same machinery.
 */
export const Material = {
  Air: 0,
  Sand: 1,
  Snow: 2,
  Dirt: 3,
  Clay: 4,
  Gravel: 5,
  Rock: 6,
  Granite: 7,
  Ice: 8,
  Wood: 9,
  Leaf: 10,
} as const;

export type Material = (typeof Material)[keyof typeof Material];

export const MATERIAL_COUNT = 11;

/**
 * `satisfies Record<Material, ...>` is the point of these tables: adding a
 * material to the enum above becomes a compile error here until it is
 * classified, which is strictly better than the C++'s exhaustive switches
 * (those only warn, and only with the right flags).
 */

/** Air is the only non-solid material. */
export function isSolid(material: Material): boolean {
  return material !== Material.Air;
}

/**
 * No tool/equipment system exists yet, so "hand digging" (the scoop) can only
 * remove soft materials; Rock/Granite/Ice need a future tool tier. Leaf is
 * scoop-removable (foliage); Wood (trunk) is not -- trunks are chup-only.
 *
 * Note Air is `true` here, which is load-bearing downstream: chopVoxelGrid
 * guards with `isSolid(m) && isChoppable(m)` precisely because this returns
 * true for Air (see the comment at TreeVoxels.cpp:453-459).
 */
const HAND_DIGGABLE = {
  [Material.Air]: true,
  [Material.Sand]: true,
  [Material.Snow]: true,
  [Material.Dirt]: true,
  [Material.Clay]: true,
  [Material.Gravel]: true,
  [Material.Rock]: false,
  [Material.Granite]: false,
  [Material.Ice]: false,
  [Material.Wood]: false,
  [Material.Leaf]: true,
} as const satisfies Record<Material, boolean>;

export function isHandDiggable(material: Material): boolean {
  return HAND_DIGGABLE[material];
}

/**
 * Gates the chup (chop) action: the same hardness tier scoop uses, plus Wood
 * -- trunks are hand-diggable's one deliberate exception, not a special case
 * unto themselves.
 */
export function isChoppable(material: Material): boolean {
  return isHandDiggable(material) || material === Material.Wood;
}

/**
 * Flat placeholder colours, vertex-coloured rather than textured (DESIGN.md's
 * low-texture-memory goal). Tuned for visual distinction, not accuracy.
 *
 * Stored as a flat Float32Array LUT indexed `material * 3` rather than as
 * objects: the mesher reads this once per emitted quad, and returning a fresh
 * {r,g,b} there would allocate on every quad of every chunk.
 */
export const MATERIAL_COLORS = new Float32Array([
  0.0, 0.0, 0.0, // Air (never drawn)
  0.86, 0.78, 0.53, // Sand
  0.95, 0.95, 0.97, // Snow
  0.45, 0.32, 0.2, // Dirt
  0.62, 0.42, 0.35, // Clay
  0.55, 0.55, 0.55, // Gravel
  0.4, 0.4, 0.42, // Rock
  0.6, 0.5, 0.48, // Granite
  0.75, 0.9, 0.95, // Ice
  0.36, 0.24, 0.15, // Wood
  0.25, 0.48, 0.17, // Leaf
]);

/**
 * Floor division/modulo. JS `/` on integers yields a float and `%` takes the
 * sign of the dividend, neither of which is what chunk coordinate maths needs
 * for negative world voxel coordinates. Matches floorDiv/floorMod in
 * src/voxel/Voxel.hpp.
 */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export function floorMod(a: number, b: number): number {
  const r = a % b;
  return r !== 0 && r < 0 !== b < 0 ? r + b : r;
}
