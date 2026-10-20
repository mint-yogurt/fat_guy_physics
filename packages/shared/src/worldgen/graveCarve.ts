import { CHUNK_SIZE, VOXEL_SIZE } from "../sim/constants.ts";
import { Material } from "../voxel/voxel.ts";
import { GRAVE_BOX } from "./props.ts";
import type { PropPlacement } from "./spawns.ts";

/**
 * Cuts the pit an open grave sits in.
 *
 * The grave mesh is a box sunk into the ground, and the ground is solid
 * voxels all the way through, so without this an open grave would be a
 * hollow box buried in dirt: invisible, and full. This clears the voxels the
 * box occupies -- through the same yaw and lean the mesh is drawn with, so a
 * crooked grave gets a crooked hole -- and the mesh then fills the hole.
 *
 * Works chunk by chunk, since a pit can straddle chunks and the worker that
 * generates one has no business reading its neighbour: each chunk clears
 * only its own share, from the same placement.
 */
export function carveGrave(
  cells: Uint8Array,
  originX: number,
  originY: number,
  originZ: number,
  grave: PropPlacement,
): void {
  const s = grave.scale;
  const halfLength = GRAVE_BOX.halfLength * s;
  const halfWidth = GRAVE_BOX.halfWidth * s;
  const top = GRAVE_BOX.top * s;
  const bottom = GRAVE_BOX.bottom * s;

  // Generous bounds: a leaning box's corners swing out and down, and the
  // exact reach is not worth working out when the per-voxel test is exact.
  const reach = Math.hypot(halfLength, halfWidth) + 0.4;
  const minX = Math.max(originX, Math.floor((grave.x - reach) / VOXEL_SIZE));
  const maxX = Math.min(originX + CHUNK_SIZE - 1, Math.floor((grave.x + reach) / VOXEL_SIZE));
  const minZ = Math.max(originZ, Math.floor((grave.z - reach) / VOXEL_SIZE));
  const maxZ = Math.min(originZ + CHUNK_SIZE - 1, Math.floor((grave.z + reach) / VOXEL_SIZE));
  const minY = Math.max(originY, Math.floor((grave.y + bottom - reach * 0.25) / VOXEL_SIZE));
  const maxY = Math.min(originY + CHUNK_SIZE - 1, Math.floor((grave.y + top + reach * 0.25) / VOXEL_SIZE));
  if (minX > maxX || minY > maxY || minZ > maxZ) return;

  const cosYaw = Math.cos(grave.yaw);
  const sinYaw = Math.sin(grave.yaw);
  const cosX = Math.cos(grave.tiltX);
  const sinX = Math.sin(grave.tiltX);
  const cosZ = Math.cos(grave.tiltZ);
  const sinZ = Math.sin(grave.tiltZ);

  for (let vz = minZ; vz <= maxZ; vz++) {
    for (let vy = minY; vy <= maxY; vy++) {
      for (let vx = minX; vx <= maxX; vx++) {
        const px = (vx + 0.5) * VOXEL_SIZE - grave.x;
        const py = (vy + 0.5) * VOXEL_SIZE - grave.y;
        const pz = (vz + 0.5) * VOXEL_SIZE - grave.z;

        // World -> the grave's own frame: undo yaw, then the lean about X,
        // then the lean about Z -- the reverse of how the mesh is posed.
        const x1 = px * cosYaw - pz * sinYaw;
        const z1 = px * sinYaw + pz * cosYaw;
        const y2 = py * cosX + z1 * sinX;
        const z2 = -py * sinX + z1 * cosX;
        const x3 = x1 * cosZ + y2 * sinZ;
        const y3 = -x1 * sinZ + y2 * cosZ;

        if (Math.abs(x3) >= halfLength || Math.abs(z2) >= halfWidth) continue;
        if (y3 >= top || y3 <= bottom) continue;

        const lx = vx - originX;
        const ly = vy - originY;
        const lz = vz - originZ;
        cells[lx + CHUNK_SIZE * (ly + CHUNK_SIZE * lz)] = Material.Air;
      }
    }
  }
}
