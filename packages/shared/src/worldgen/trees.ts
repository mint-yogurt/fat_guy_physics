import { hash32, hashFloat } from "../rng/hash.ts";
import { Material } from "../voxel/voxel.ts";
import { createGrid, gridAt, gridSet, type VoxelGrid } from "../voxel/voxelGrid.ts";

/**
 * Procedural tree/bush voxelisation.
 *
 * This is a redesign of src/voxel/TreeVoxels.cpp's generator rather than a
 * port of it, for the two reasons the roadmap calls out:
 *
 *  - **Canopy size.** The C++ scales canopy radius by 1.0-1.6x the *trunk
 *    height* and clamps at 32 voxels, so a 3m tree grows a 3.2m-radius
 *    canopy -- a mushroom, and wide enough that neighbouring canopies merge
 *    into a ceiling. Canopy extent here is a fraction of trunk height.
 *  - **Shape variety.** The C++ has exactly one silhouette (cylinder plus a
 *    noise-perturbed ellipsoid) and jitters its dimensions, which reads as
 *    one tree at several sizes. There are four distinct species here, and
 *    the broadleaf's canopy is an irregular union of lobes rather than one
 *    threshold-perturbed blob, so no two are the same shape.
 *
 * Species serve DESIGN.md's holiday-region direction: conifers for the
 * Christmas regions, bare gnarled trunks for Halloween, broadleaf and bush
 * as the neutral filler. Which species a region favours is M13's job; this
 * only has to be able to build each of them.
 */

export const TreeSpecies = {
  Conifer: 0,
  Broadleaf: 1,
  Dead: 2,
  Bush: 3,
} as const;
export type TreeSpecies = (typeof TreeSpecies)[keyof typeof TreeSpecies];

export interface TreeShape {
  readonly grid: VoxelGrid;
  readonly species: TreeSpecies;
  /** Trunk occupies local Y in [0, trunkHeightVoxels). */
  readonly trunkHeightVoxels: number;
  readonly trunkRadiusVoxels: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Fills an axis-aligned ellipsoid, never overwriting an existing voxel. */
function plotBlob(
  grid: VoxelGrid,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number,
  material: Material,
): void {
  const x0 = Math.floor(cx - rx);
  const x1 = Math.ceil(cx + rx);
  const y0 = Math.floor(cy - ry);
  const y1 = Math.ceil(cy + ry);
  const z0 = Math.floor(cz - rz);
  const z1 = Math.ceil(cz + rz);
  for (let y = y0; y <= y1; y++) {
    const ny = (y - cy) / ry;
    for (let z = z0; z <= z1; z++) {
      const nz = (z - cz) / rz;
      for (let x = x0; x <= x1; x++) {
        const nx = (x - cx) / rx;
        if (nx * nx + ny * ny + nz * nz > 1) continue;
        // Air-only: leaves must never eat trunk, whatever order they are
        // plotted in.
        if (gridAt(grid, x, y, z) !== Material.Air) continue;
        gridSet(grid, x, y, z, material);
      }
    }
  }
}

/** A thick voxel line, for trunks and branches. */
function plotLine(
  grid: VoxelGrid,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  radius: number,
  material: Material,
): void {
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0))) + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = lerp(x0, x1, t);
    const cy = lerp(y0, y1, t);
    const cz = lerp(z0, z1, t);
    const r0 = Math.floor(-radius);
    const r1 = Math.ceil(radius);
    for (let dy = r0; dy <= r1; dy++) {
      for (let dz = r0; dz <= r1; dz++) {
        for (let dx = r0; dx <= r1; dx++) {
          const px = Math.round(cx) + dx;
          const py = Math.round(cy) + dy;
          const pz = Math.round(cz) + dz;
          const ox = px - cx;
          const oz = pz - cz;
          if (ox * ox + oz * oz > radius * radius) continue;
          gridSet(grid, px, py, pz, material);
        }
      }
    }
  }
}

/**
 * Builds one tree.
 *
 * `severedAtLocalY` regenerates a stump instead of an intact tree: a chup'd
 * tree whose chunk streams out and back in must not grow its top back, and
 * the only state kept for that is the Y it was cut at (see World's severed
 * map).
 */
export function generateTree(
  treeHash: number,
  species: TreeSpecies,
  severedAtLocalY?: number,
): TreeShape {
  const rnd = (salt: number): number => hashFloat(treeHash, salt, 0, 0);

  let trunkHeight: number;
  let trunkRadius: number;
  let reachX: number;
  let reachY: number;

  switch (species) {
    case TreeSpecies.Conifer:
      trunkHeight = Math.round(lerp(34, 56, rnd(1)));
      trunkRadius = lerp(1.1, 1.8, rnd(2));
      reachX = Math.ceil(lerp(7, 12, rnd(3)));
      reachY = trunkHeight + 8;
      break;
    case TreeSpecies.Broadleaf:
      trunkHeight = Math.round(lerp(22, 36, rnd(1)));
      trunkRadius = lerp(1.4, 2.2, rnd(2));
      reachX = Math.ceil(lerp(8, 13, rnd(3)));
      reachY = trunkHeight + Math.ceil(reachX * 0.9);
      break;
    case TreeSpecies.Dead:
      trunkHeight = Math.round(lerp(26, 44, rnd(1)));
      trunkRadius = lerp(1.0, 1.6, rnd(2));
      reachX = Math.ceil(lerp(6, 12, rnd(3)));
      reachY = trunkHeight + 4;
      break;
    default:
      trunkHeight = 0;
      trunkRadius = 0;
      reachX = Math.ceil(lerp(3, 6, rnd(3)));
      reachY = Math.ceil(reachX * 2);
      break;
  }

  if (severedAtLocalY !== undefined) {
    // A stump is trunk and nothing else, so the grid only has to be wide
    // enough for the trunk itself.
    trunkHeight = Math.max(1, severedAtLocalY);
    reachX = Math.ceil(trunkRadius) + 1;
    reachY = trunkHeight + 1;
  }

  const pad = 2;
  const halfWidth = reachX + pad;
  const grid = createGrid(
    halfWidth * 2 + 1,
    reachY + pad,
    halfWidth * 2 + 1,
    halfWidth,
    0,
    halfWidth,
  );

  if (trunkHeight > 0) {
    plotLine(grid, 0, 0, 0, 0, trunkHeight - 1, 0, trunkRadius, Material.Wood);
  }

  if (severedAtLocalY === undefined) {
    switch (species) {
      case TreeSpecies.Conifer: {
        // A cone with a whorl ripple: the ripple is what makes it read as
        // tiered branches rather than an ice-cream cone.
        const base = Math.round(trunkHeight * 0.3);
        const top = trunkHeight + Math.round(lerp(4, 8, rnd(4)));
        const whorlPitch = lerp(4, 7, rnd(5));
        const phase = rnd(6) * Math.PI * 2;
        for (let y = base; y <= top; y++) {
          const t = (y - base) / (top - base);
          const cone = reachX * (1 - t) ** 0.85;
          const ripple = 1 + 0.3 * Math.sin((y / whorlPitch) * Math.PI * 2 + phase);
          const r = Math.max(1, cone * ripple);
          plotBlob(grid, 0, y, 0, r, 1, r, Material.Leaf);
        }
        break;
      }
      case TreeSpecies.Broadleaf: {
        const lobes = 3 + Math.floor(rnd(4) * 3);
        for (let i = 0; i < lobes; i++) {
          const angle = (i / lobes + rnd(10 + i) * 0.4) * Math.PI * 2;
          const spread = reachX * lerp(0.15, 0.55, rnd(20 + i));
          const lx = Math.cos(angle) * spread;
          const lz = Math.sin(angle) * spread;
          const ly = trunkHeight * lerp(0.85, 1.0, rnd(30 + i)) + reachX * 0.4;
          const lr = reachX * lerp(0.55, 0.95, rnd(40 + i));
          plotBlob(grid, lx, ly, lz, lr, lr * 0.8, lr, Material.Leaf);
          // A stub of real trunk into each lobe, so chopping the trunk
          // leaves something recognisable behind and the canopy is not a
          // cloud floating over a pole.
          if (i < 3) {
            plotLine(
              grid,
              0,
              trunkHeight * 0.75,
              0,
              lx,
              ly - lr * 0.3,
              lz,
              Math.max(1, trunkRadius * 0.5),
              Material.Wood,
            );
          }
        }
        break;
      }
      case TreeSpecies.Dead: {
        const branches = 4 + Math.floor(rnd(4) * 4);
        for (let i = 0; i < branches; i++) {
          const angle = (i / branches + rnd(10 + i) * 0.5) * Math.PI * 2;
          const y0 = trunkHeight * lerp(0.45, 0.95, rnd(20 + i));
          const length = lerp(reachX * 0.5, reachX, rnd(30 + i));
          const rise = length * lerp(0.3, 1.1, rnd(40 + i));
          plotLine(
            grid,
            0,
            y0,
            0,
            Math.cos(angle) * length,
            y0 + rise,
            Math.sin(angle) * length,
            Math.max(1, trunkRadius * 0.55),
            Material.Wood,
          );
        }
        break;
      }
      default: {
        const lobes = 1 + Math.floor(rnd(4) * 3);
        for (let i = 0; i < lobes; i++) {
          const angle = rnd(10 + i) * Math.PI * 2;
          const spread = reachX * lerp(0, 0.5, rnd(20 + i));
          const lr = reachX * lerp(0.6, 1, rnd(30 + i));
          plotBlob(
            grid,
            Math.cos(angle) * spread,
            lr * 0.9,
            Math.sin(angle) * spread,
            lr,
            lr * 0.85,
            lr,
            Material.Leaf,
          );
        }
        break;
      }
    }
  }

  return { grid, species, trunkHeightVoxels: trunkHeight, trunkRadiusVoxels: trunkRadius };
}

/** Picks a species for a placement. M13 will weight this per biome. */
export function speciesForPlacement(treeHash: number): TreeSpecies {
  const roll = hashFloat(treeHash, 7, 0, 0);
  if (roll < 0.42) return TreeSpecies.Conifer;
  if (roll < 0.78) return TreeSpecies.Broadleaf;
  return TreeSpecies.Dead;
}

export function treeHashAt(worldVoxelX: number, worldVoxelZ: number, seed: number): number {
  // Unsigned, so an id is never negative and `>= 0` stays a valid test.
  return hash32(worldVoxelX, worldVoxelZ, seed, 3) >>> 0;
}
