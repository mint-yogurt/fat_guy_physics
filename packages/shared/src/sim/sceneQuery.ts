import { VOXEL_SIZE } from "./constants.ts";
import type { SolidQuery } from "./collision.ts";
import { Material } from "../voxel/voxel.ts";
import { gridAt, type VoxelGrid } from "../voxel/voxelGrid.ts";

/**
 * Terrain plus arbitrarily-oriented voxel bodies, as one {@link SolidQuery}.
 *
 * This is the real fix for walking on felled logs, replacing the native
 * build's "snap-on-sleep" stopgap -- there, a settled log's rotation was
 * snapped to the nearest of 24 axis-aligned orientations so it could reuse
 * terrain's integer-voxel collision, which meant a log resting at a genuine
 * tilt, or on a slope, stayed walk-through. See the comment on
 * World::isSolidIncludingSnappedLogs.
 *
 * It is cheap here only because this collision code samples *points*
 * rather than intersecting shapes: a point transforms into a body's local
 * frame with one quaternion rotation, and the body's voxel grid answers
 * directly. There is no snapping, no second collision representation, and
 * nothing a body has to be rounded to.
 *
 * Bodies are expected to be few (settled logs within a few metres). The
 * sweep calls isSolid a few hundred times per substep, so the list is
 * walked, not spatially indexed; that stops being true somewhere north of a
 * few dozen bodies, which is a problem worth having.
 */

export interface OrientedBody {
  readonly grid: VoxelGrid;
  /** World position of the grid's local (0,0,0). */
  x: number;
  y: number;
  z: number;
  /** Body rotation, as a unit quaternion. */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export class SceneSolidQuery implements SolidQuery {
  /** Mutated in place by whoever owns the bodies; never reallocated. */
  readonly bodies: OrientedBody[] = [];

  constructor(private readonly terrain: SolidQuery) {}

  isSolid(vx: number, vy: number, vz: number): boolean {
    if (this.terrain.isSolid(vx, vy, vz)) return true;
    if (this.bodies.length === 0) return false;

    // The voxel's centre is the sample point. Using the corner would bias
    // every body half a voxel in -X/-Y/-Z.
    const px = (vx + 0.5) * VOXEL_SIZE;
    const py = (vy + 0.5) * VOXEL_SIZE;
    const pz = (vz + 0.5) * VOXEL_SIZE;

    for (const body of this.bodies) {
      const dx = px - body.x;
      const dy = py - body.y;
      const dz = pz - body.z;

      // Rotate by the conjugate: world -> body local. Written out rather
      // than via a quaternion class because this runs a few hundred times
      // per substep and the allocation would dominate it.
      const qx = -body.qx;
      const qy = -body.qy;
      const qz = -body.qz;
      const qw = body.qw;

      const tx = 2 * (qy * dz - qz * dy);
      const ty = 2 * (qz * dx - qx * dz);
      const tz = 2 * (qx * dy - qy * dx);

      const lx = dx + qw * tx + (qy * tz - qz * ty);
      const ly = dy + qw * ty + (qz * tx - qx * tz);
      const lz = dz + qw * tz + (qx * ty - qy * tx);

      if (
        gridAt(
          body.grid,
          Math.floor(lx / VOXEL_SIZE),
          Math.floor(ly / VOXEL_SIZE),
          Math.floor(lz / VOXEL_SIZE),
        ) !== Material.Air
      ) {
        return true;
      }
    }

    return false;
  }
}
