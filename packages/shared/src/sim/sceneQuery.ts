import { VOXEL_SIZE } from "./constants.ts";
import type { SolidQuery } from "./collision.ts";
import { MoundList } from "./mound.ts";

/**
 * Terrain plus arbitrarily-oriented cylinders, as one {@link SolidQuery}.
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
 * frame with one quaternion rotation, and a cylinder answers in two
 * comparisons. There is no snapping, no second collision representation,
 * and nothing a body has to be rounded to.
 *
 * Bodies are expected to be few (settled logs within a few metres). The
 * sweep calls isSolid a few hundred times per substep, so the list is
 * walked, not spatially indexed; that stops being true somewhere north of a
 * few dozen bodies, which is a problem worth having.
 */

export interface OrientedBody {
  /** Radius of the cylinder, and half its length along its own Y. */
  readonly radius: number;
  readonly halfHeight: number;
  /** World position of the cylinder's centre. */
  x: number;
  y: number;
  z: number;
  /** Body rotation, as a unit quaternion. */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/**
 * A box that is only ever turned about the vertical: a wall. Its half sizes
 * are along its own axes, and `cos`/`sin` are of the yaw that turns the box's
 * own X and Z onto the world's, the way three's Y rotation does (local
 * (lx, lz) is world (lx cos + lz sin, -lx sin + lz cos)).
 */
export interface YawBox {
  x: number;
  y: number;
  z: number;
  halfX: number;
  halfY: number;
  halfZ: number;
  cos: number;
  sin: number;
}

export class SceneSolidQuery implements SolidQuery {
  /** Mutated in place by whoever owns the bodies; never reallocated. */
  readonly bodies: OrientedBody[] = [];
  /** Walls near the player (a gingerbread house's); owned and rebuilt by main, like `statics`. */
  readonly boxes: YawBox[] = [];
  /**
   * Standing trunks and stumps near the player. Kept apart from `bodies`
   * because the two lists have different owners rebuilding them each
   * frame: the log system owns `bodies`, main owns this.
   */
  readonly statics: OrientedBody[] = [];
  /** Snowbanks near the player or near snow rolling about; owned and rebuilt by main. */
  readonly mounds = new MoundList();

  constructor(private readonly terrain: SolidQuery) {}

  isSolid(vx: number, vy: number, vz: number): boolean {
    if (this.terrain.isSolid(vx, vy, vz)) return true;
    if (
      this.bodies.length === 0 &&
      this.statics.length === 0 &&
      this.boxes.length === 0 &&
      this.mounds.count === 0
    ) {
      return false;
    }

    // The voxel's centre is the sample point. Using the corner would bias
    // every body half a voxel in -X/-Y/-Z.
    const px = (vx + 0.5) * VOXEL_SIZE;
    const py = (vy + 0.5) * VOXEL_SIZE;
    const pz = (vz + 0.5) * VOXEL_SIZE;
    return (
      insideAny(this.bodies, px, py, pz) ||
      insideAny(this.statics, px, py, pz) ||
      insideAnyBox(this.boxes, px, py, pz) ||
      this.mounds.contains(px, py, pz)
    );
  }
}

function insideAnyBox(boxes: readonly YawBox[], px: number, py: number, pz: number): boolean {
  for (const box of boxes) {
    if (Math.abs(py - box.y) > box.halfY) continue;
    const dx = px - box.x;
    const dz = pz - box.z;
    // World -> the box's own frame: the inverse of the yaw.
    const lx = dx * box.cos - dz * box.sin;
    const lz = dx * box.sin + dz * box.cos;
    if (Math.abs(lx) <= box.halfX && Math.abs(lz) <= box.halfZ) return true;
  }
  return false;
}

function insideAny(bodies: readonly OrientedBody[], px: number, py: number, pz: number): boolean {
  for (const body of bodies) {
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

    if (Math.abs(ly) <= body.halfHeight && lx * lx + lz * lz <= body.radius * body.radius) {
      return true;
    }
  }
  return false;
}
