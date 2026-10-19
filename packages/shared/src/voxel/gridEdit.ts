import { VOXEL_SIZE } from "../sim/constants.ts";
import { isChoppable, isSolid, Material } from "./voxel.ts";
import { createGrid, gridIndex, gridSet, type VoxelGrid } from "./voxelGrid.ts";

/**
 * Edits on a standalone voxel grid (a tree, and from M7 a felled log),
 * positioned by an integer root voxel.
 *
 * Replaces the grid-generic half of src/voxel/TreeVoxels.cpp. Two
 * differences from it, both deliberate:
 *
 *  - **No rotation.** The C++ takes a (position, quaternion) pair because a
 *    tumbled log reuses this code. Nothing is rotated yet; M8's oriented-body
 *    work adds the quaternion back when there is something to rotate.
 *  - **Integer root.** Trees are placed on the terrain's own voxel lattice,
 *    so a grid cell and a world voxel are the same size and in phase. The
 *    C++ jitters the root to a fractional position, which is why it needs a
 *    separate tree raycast at all -- here the scene raycast is one DDA over
 *    world voxels that happens to consult both.
 */

/** Clears Leaf within a sphere. Returns true if anything was removed. */
export function digGridSphere(
  grid: VoxelGrid,
  rootVoxelX: number,
  rootVoxelY: number,
  rootVoxelZ: number,
  centerX: number,
  centerY: number,
  centerZ: number,
  radiusMeters: number,
): boolean {
  const radiusSq = radiusMeters * radiusMeters;
  const r = Math.ceil(radiusMeters / VOXEL_SIZE);
  const cvx = Math.floor(centerX / VOXEL_SIZE) - rootVoxelX;
  const cvy = Math.floor(centerY / VOXEL_SIZE) - rootVoxelY;
  const cvz = Math.floor(centerZ / VOXEL_SIZE) - rootVoxelZ;
  let changed = false;

  for (let dy = -r; dy <= r; dy++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const lx = cvx + dx;
        const ly = cvy + dy;
        const lz = cvz + dz;
        const gx = lx + grid.originX;
        const gy = ly + grid.originY;
        const gz = lz + grid.originZ;
        if (gx < 0 || gx >= grid.dimX || gy < 0 || gy >= grid.dimY || gz < 0 || gz >= grid.dimZ) {
          continue;
        }
        const index = gridIndex(grid, gx, gy, gz);
        // Wood is chup-only (isHandDiggable), so the scoop only ever takes
        // foliage off a tree.
        if (grid.cells[index] !== Material.Leaf) continue;

        const ox = (lx + rootVoxelX + 0.5) * VOXEL_SIZE - centerX;
        const oy = (ly + rootVoxelY + 0.5) * VOXEL_SIZE - centerY;
        const oz = (lz + rootVoxelZ + 0.5) * VOXEL_SIZE - centerZ;
        if (ox * ox + oy * oy + oz * oz > radiusSq) continue;

        grid.cells[index] = Material.Air;
        changed = true;
      }
    }
  }
  return changed;
}

export interface ChopResult {
  /** True if any voxel was cleared. */
  changed: boolean;
  /**
   * Local Y the grid was cut through, or -1. A cut happens when a chop
   * leaves a Y band with no Wood left in it while Wood remains above:
   * nothing is holding the top on, so it comes off. There is no hit
   * counter -- a thick trunk simply takes several swings to clear a band,
   * which is where "chopping takes a while bare-handed" comes from.
   */
  severedAtLocalY: number;
}

const chopResult: ChopResult = { changed: false, severedAtLocalY: -1 };

/** True if any Wood remains in the grid at local Y `ly`. */
function bandHasWood(grid: VoxelGrid, ly: number): boolean {
  const gy = ly + grid.originY;
  if (gy < 0 || gy >= grid.dimY) return false;
  for (let gz = 0; gz < grid.dimZ; gz++) {
    const rowBase = grid.dimX * (gy + grid.dimY * gz);
    for (let gx = 0; gx < grid.dimX; gx++) {
      if (grid.cells[rowBase + gx] === Material.Wood) return true;
    }
  }
  return false;
}

function woodAbove(grid: VoxelGrid, ly: number): boolean {
  for (let y = ly + 1; y < grid.dimY - grid.originY; y++) {
    if (bandHasWood(grid, y)) return true;
  }
  return false;
}

/**
 * Chup: shears a thin horizontal disc out of the grid -- wide in X/Z, thin
 * in Y, a notch rather than the scoop's sphere. Clears anything choppable,
 * foliage included, so a swing near the trunk/canopy boundary takes both.
 *
 * The returned object is reused between calls.
 */
export function chopGridDisc(
  grid: VoxelGrid,
  rootVoxelX: number,
  rootVoxelY: number,
  rootVoxelZ: number,
  centerX: number,
  centerY: number,
  centerZ: number,
  horizontalRadiusMeters: number,
  verticalHalfThicknessMeters: number,
): ChopResult {
  chopResult.changed = false;
  chopResult.severedAtLocalY = -1;

  const hSq = horizontalRadiusMeters * horizontalRadiusMeters;
  const rh = Math.ceil(horizontalRadiusMeters / VOXEL_SIZE);
  const rv = Math.ceil(verticalHalfThicknessMeters / VOXEL_SIZE);
  const cvx = Math.floor(centerX / VOXEL_SIZE) - rootVoxelX;
  const cvy = Math.floor(centerY / VOXEL_SIZE) - rootVoxelY;
  const cvz = Math.floor(centerZ / VOXEL_SIZE) - rootVoxelZ;

  let woodCleared = false;
  let lowestWoodBand = 0;
  let highestWoodBand = 0;

  for (let dy = -rv; dy <= rv; dy++) {
    for (let dz = -rh; dz <= rh; dz++) {
      for (let dx = -rh; dx <= rh; dx++) {
        const lx = cvx + dx;
        const ly = cvy + dy;
        const lz = cvz + dz;
        const gx = lx + grid.originX;
        const gy = ly + grid.originY;
        const gz = lz + grid.originZ;
        if (gx < 0 || gx >= grid.dimX || gy < 0 || gy >= grid.dimY || gz < 0 || gz >= grid.dimZ) {
          continue;
        }
        const index = gridIndex(grid, gx, gy, gz);
        const material = grid.cells[index] as Material;
        if (!isSolid(material) || !isChoppable(material)) continue;

        const ox = (lx + rootVoxelX + 0.5) * VOXEL_SIZE - centerX;
        const oz = (lz + rootVoxelZ + 0.5) * VOXEL_SIZE - centerZ;
        const oy = (ly + rootVoxelY + 0.5) * VOXEL_SIZE - centerY;
        if (ox * ox + oz * oz > hSq) continue;
        if (Math.abs(oy) > verticalHalfThicknessMeters) continue;

        if (material === Material.Wood) {
          if (!woodCleared || ly < lowestWoodBand) lowestWoodBand = ly;
          if (!woodCleared || ly > highestWoodBand) highestWoodBand = ly;
          woodCleared = true;
        }
        grid.cells[index] = Material.Air;
        chopResult.changed = true;
      }
    }
  }

  // Only bands this swing actually took Wood out of can have become empty,
  // so the severance scan never walks the whole grid.
  if (woodCleared) {
    for (let ly = lowestWoodBand; ly <= highestWoodBand; ly++) {
      if (bandHasWood(grid, ly)) continue;
      if (!woodAbove(grid, ly)) continue;
      chopResult.severedAtLocalY = ly;
      break;
    }
  }

  return chopResult;
}

/**
 * Splits the grid at local Y == `severLocalY`: everything at or above it is
 * cleared from `grid` and returned as a new grid.
 *
 * The returned piece's local (0,0,0) is the centre of its own bounding box
 * in Y and the original trunk axis in X/Z, so it lines up with the capsule
 * body that is about to carry it -- a mesh whose origin is the body's
 * centre of mass needs no offset when the body transform is applied to it.
 *
 * Returns undefined if there was nothing above the cut.
 */
export function severGridAt(grid: VoxelGrid, severLocalY: number): VoxelGrid | undefined {
  const topLocalY = grid.dimY - grid.originY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let ly = severLocalY; ly < topLocalY; ly++) {
    const gy = ly + grid.originY;
    if (gy < 0 || gy >= grid.dimY) continue;
    for (let gz = 0; gz < grid.dimZ; gz++) {
      const rowBase = grid.dimX * (gy + grid.dimY * gz);
      for (let gx = 0; gx < grid.dimX; gx++) {
        if (grid.cells[rowBase + gx] === Material.Air) continue;
        const lx = gx - grid.originX;
        const lz = gz - grid.originZ;
        if (ly < minY) minY = ly;
        if (ly > maxY) maxY = ly;
        if (lx < minX) minX = lx;
        if (lx > maxX) maxX = lx;
        if (lz < minZ) minZ = lz;
        if (lz > maxZ) maxZ = lz;
      }
    }
  }

  if (minY > maxY) return undefined;

  const centerY = Math.round((minY + maxY) / 2);
  const piece = createGrid(
    maxX - minX + 1,
    maxY - minY + 1,
    maxZ - minZ + 1,
    -minX,
    centerY - minY,
    -minZ,
  );

  for (let ly = minY; ly <= maxY; ly++) {
    const gy = ly + grid.originY;
    for (let gz = 0; gz < grid.dimZ; gz++) {
      const rowBase = grid.dimX * (gy + grid.dimY * gz);
      for (let gx = 0; gx < grid.dimX; gx++) {
        const material = grid.cells[rowBase + gx] as Material;
        if (material === Material.Air) continue;
        gridSet(piece, gx - grid.originX, ly - centerY, gz - grid.originZ, material);
        grid.cells[rowBase + gx] = Material.Air;
      }
    }
  }

  return piece;
}
