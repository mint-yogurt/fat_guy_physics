/**
 * Floor division/modulo. JS `/` on integers yields a float and `%` takes the
 * sign of the dividend, neither of which is what grid-cell maths needs for
 * negative coordinates. Matches floorDiv/floorMod in the old src/voxel/Voxel.hpp.
 *
 * (This folder is what is left of the voxel era -- the 10 cm grid the collision code and
 * the placement hashing still count in. The ground is no longer voxels; see DESIGN.md.)
 */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export function floorMod(a: number, b: number): number {
  const r = a % b;
  return r !== 0 && r < 0 !== b < 0 ? r + b : r;
}
