import { GRAVE_BOX } from "./props.ts";
import { placeCell, type Placement } from "./spawns.ts";
import type { TerrainGenerator } from "./terrainGenerator.ts";

/**
 * The pits open graves sit in.
 *
 * The grave mesh is a box sunk into the ground, and the ground is a solid surface across its
 * top, so without a hole an open grave would be a hollow box buried in dirt: invisible, and
 * full. A tile that has an open grave in it (or one reaching into it) is built on a finer
 * lattice (groundMesh.ts) with the ground lowered to the box's floor inside its footprint,
 * which the mesh then fills the hole of. The walls of the pit are the steep triangles between
 * the rim and the floor, hidden behind the box's own.
 *
 * Covered graves (topsoil) are left alone: the mound hides the box anyway, and a hole under a
 * mound the player can walk across would be a trapdoor.
 *
 * A grave is at most ~1.3 m across against a 3.2 m tile, so only the 3x3 tiles around one can
 * hold a grave that touches it -- the same neighbourhood placement uses.
 */

/** How far inside the box's walls the lowered ground starts, so the pit's rim hides behind them. */
const RIM_INSET = 0.08;
/** Just above the box's floor, so the two never fight over the same pixels. */
const FLOOR_LIFT = 0.03;

export interface Pit {
  readonly x: number;
  readonly z: number;
  readonly cosYaw: number;
  readonly sinYaw: number;
  readonly halfLength: number;
  readonly halfWidth: number;
  /** Height of the pit's floor, metres. */
  readonly floor: number;
}

const placementScratch: Placement[] = [];

/** The open graves whose pits can touch tile (cx, cz), into `out`. */
export function pitsNear(generator: TerrainGenerator, cx: number, cz: number, out: Pit[]): Pit[] {
  out.length = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      placementScratch.length = 0;
      placeCell(generator, cx + dx, cz + dz, generator.seed, placementScratch);
      for (const placement of placementScratch) {
        if (placement.type !== "prop" || placement.kind !== "grave" || placement.topsoil) continue;
        const s = placement.scale;
        out.push({
          x: placement.x,
          z: placement.z,
          cosYaw: Math.cos(placement.yaw),
          sinYaw: Math.sin(placement.yaw),
          halfLength: Math.max(0.1, GRAVE_BOX.halfLength * s - RIM_INSET),
          halfWidth: Math.max(0.1, GRAVE_BOX.halfWidth * s - RIM_INSET),
          floor: placement.y + GRAVE_BOX.bottom * s + FLOOR_LIFT,
        });
      }
    }
  }
  return out;
}

/** Whether (x, z) is inside any pit, and the floor height of the lowest one it is in (else NaN). */
export function pitFloorAt(pits: readonly Pit[], x: number, z: number): number {
  let floor = Number.NaN;
  for (const pit of pits) {
    const px = x - pit.x;
    const pz = z - pit.z;
    // World -> the grave's own frame, as the mesh is posed (yaw only; a leaning grave's pit stays upright).
    const x1 = px * pit.cosYaw - pz * pit.sinYaw;
    const z1 = px * pit.sinYaw + pz * pit.cosYaw;
    if (Math.abs(x1) >= pit.halfLength || Math.abs(z1) >= pit.halfWidth) continue;
    if (Number.isNaN(floor) || pit.floor < floor) floor = pit.floor;
  }
  return floor;
}
