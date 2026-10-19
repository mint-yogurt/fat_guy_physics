import type { SolidQuery } from "../sim/collision.ts";
import { VOXEL_SIZE } from "../sim/constants.ts";

/**
 * Amanatides & Woo voxel DDA. Ports src/voxel/VoxelRaycast.cpp.
 *
 * Stops at the first solid voxel within `maxDistanceMeters`, regardless of
 * hardness -- hardness gates *removal*, not aim, otherwise players could see
 * (and dig) straight through Rock.
 *
 * Writes into a caller-owned result rather than returning an object: this
 * runs several times a second while digging and once a frame for the
 * crosshair readout.
 */

export interface VoxelHit {
  hit: boolean;
  /** Integer world voxel coordinate of the hit. */
  x: number;
  y: number;
  z: number;
  /** Distance along the ray at which the voxel was entered, in metres. */
  distance: number;
}

export function createVoxelHit(): VoxelHit {
  return { hit: false, x: 0, y: 0, z: 0, distance: 0 };
}

// Per-axis scratch, module-level so the hot path allocates nothing. Safe to
// share: this function neither recurses nor calls back into itself.
const step = [0, 0, 0];
const tMax = [0, 0, 0];
const tDelta = [0, 0, 0];
const voxel = [0, 0, 0];
const origin = [0, 0, 0];
const dir = [0, 0, 0];

export function raycastVoxel(
  query: SolidQuery,
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  maxDistanceMeters: number,
  out: VoxelHit,
): VoxelHit {
  out.hit = false;
  out.distance = 0;

  const length = Math.hypot(dirX, dirY, dirZ);
  if (length > 0) {
    dir[0] = dirX / length;
    dir[1] = dirY / length;
    dir[2] = dirZ / length;
  } else {
    // Matches the C++ fallback for a degenerate direction.
    dir[0] = 0;
    dir[1] = 0;
    dir[2] = -1;
  }

  origin[0] = originX;
  origin[1] = originY;
  origin[2] = originZ;

  voxel[0] = Math.floor(originX / VOXEL_SIZE);
  voxel[1] = Math.floor(originY / VOXEL_SIZE);
  voxel[2] = Math.floor(originZ / VOXEL_SIZE);

  for (let axis = 0; axis < 3; axis++) {
    const d = dir[axis] ?? 0;
    const o = origin[axis] ?? 0;
    const v = voxel[axis] ?? 0;
    if (d > 0) {
      step[axis] = 1;
      tMax[axis] = ((v + 1) * VOXEL_SIZE - o) / d;
      tDelta[axis] = VOXEL_SIZE / d;
    } else if (d < 0) {
      step[axis] = -1;
      tMax[axis] = (v * VOXEL_SIZE - o) / d;
      tDelta[axis] = VOXEL_SIZE / -d;
    } else {
      step[axis] = 0;
      tMax[axis] = Number.POSITIVE_INFINITY;
      tDelta[axis] = Number.POSITIVE_INFINITY;
    }
  }

  let t = 0;
  while (t <= maxDistanceMeters) {
    if (query.isSolid(voxel[0] ?? 0, voxel[1] ?? 0, voxel[2] ?? 0)) {
      out.hit = true;
      out.x = voxel[0] ?? 0;
      out.y = voxel[1] ?? 0;
      out.z = voxel[2] ?? 0;
      out.distance = t;
      return out;
    }

    let axis = 0;
    if ((tMax[1] ?? 0) < (tMax[axis] ?? 0)) axis = 1;
    if ((tMax[2] ?? 0) < (tMax[axis] ?? 0)) axis = 2;

    voxel[axis] = (voxel[axis] ?? 0) + (step[axis] ?? 0);
    t = tMax[axis] ?? 0;
    tMax[axis] = (tMax[axis] ?? 0) + (tDelta[axis] ?? 0);
  }

  return out;
}
