import { VOXEL_SIZE } from "../sim/constants.ts";
import type { Prop, Tree } from "../sim/world.ts";
import { PROP_METRICS } from "../worldgen/props.ts";
import { CONTAINER_ITEMS, CONTAINER_KINDS, type ContainerKind } from "./container.ts";
import { ItemType } from "./inventory.ts";
import { TRAMPOLINE_HEIGHT, TRAMPOLINE_RADIUS, type TrampolineField } from "./trampoline.ts";

/**
 * Placing things: where a held item would go, and whether it can go there.
 *
 * The client shows the answer as a see-through copy of the item (the ghost,
 * render/placementPreview.ts), green where it can be placed and red where it
 * cannot, and left mouse commits it only when it is green. This file is the
 * rules, so a server can ask the same question.
 *
 * To make a new item placeable (a log, a plywood sheet, a 2x4):
 *  1. add a {@link PlacementSpec} to {@link PLACEMENTS}: its footprint, height,
 *     and whether it looks back at you;
 *  2. add a ghost builder for it in render/placementPreview.ts;
 *  3. add a case to `placeHeld` in main.ts that does the placing.
 * Nothing else changes: the aiming, the green/red test and the preview follow.
 *
 * Every placeable is a footprint (a disc or a rectangle, spun by a yaw) with a
 * height, standing on the highest ground under it. That is enough for a mat, a
 * present, a plank on the flat; a thing that leans or lies at an angle (a log
 * against a wall) will want an oriented plan rather than a yaw.
 */

export interface PlacementSpec {
  /** The footprint's half extents along the thing's own X and Z, metres. */
  readonly halfX: number;
  readonly halfZ: number;
  /** A disc (`halfX` is its radius) rather than a rectangle. */
  readonly round: boolean;
  /** How tall it stands above its base, metres. */
  readonly height: number;
  /** How far the ground may fall away under the lowest part of the footprint before it hangs in the air. */
  readonly maxGap: number;
  /** Turned to face the player (a gift), rather than fixed (a mat). */
  readonly facesPlayer: boolean;
  /**
   * Placing is all the item is for, so the first-person hand is shown empty
   * rather than holding it up in front of the view. Third person, and so other
   * players, still see it carried.
   */
  readonly hideHeldInFirstPerson: boolean;
}

function containerSpec(kind: ContainerKind): PlacementSpec {
  const metrics = PROP_METRICS[kind];
  const radius = metrics.radius * metrics.scale;
  return {
    halfX: radius,
    halfZ: radius,
    round: true,
    height: metrics.height * metrics.scale,
    maxGap: 0.3,
    facesPlayer: true,
    hideHeldInFirstPerson: true,
  };
}

/** What each placeable item needs, by item. */
export const PLACEMENTS: Partial<Record<ItemType, PlacementSpec>> = {
  [ItemType.Trampoline]: {
    halfX: TRAMPOLINE_RADIUS,
    halfZ: TRAMPOLINE_RADIUS,
    round: true,
    height: TRAMPOLINE_HEIGHT,
    // Its legs go below the base, so a mat can stand over a dip.
    maxGap: 1,
    facesPlayer: false,
    hideHeldInFirstPerson: true,
  },
};
for (const kind of CONTAINER_KINDS) PLACEMENTS[CONTAINER_ITEMS[kind]] = containerSpec(kind);

/** The placement rules of a held item, or undefined if it is not placed. */
export function placementOf(type: ItemType | undefined): PlacementSpec | undefined {
  return type === undefined ? undefined : PLACEMENTS[type];
}

/** Why a spot is no good. */
export type PlacementBlock =
  /** Nothing: it can go here. */
  | "none"
  /** Solid ground or a wall is inside it. */
  | "buried"
  /** The ground falls away too far under it. */
  | "floating"
  /** Another mat, prop or tree is in the way. */
  | "occupied"
  /** The player is standing where it would go. */
  | "player";

export interface PlacementPlan {
  /** The centre of the footprint, on its base. */
  x: number;
  y: number;
  z: number;
  /** Turn about the vertical axis, radians (three.js `rotation.y`). */
  yaw: number;
  valid: boolean;
  block: PlacementBlock;
}

/** The slice of the player a placement keeps clear. */
export interface PlacementPlayer {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly halfWidth: number;
}

/** The slice of the world a placement reads (the real `World` has all of it). */
export interface PlacementWorld {
  surfaceHeightVoxels(vx: number, vz: number): number;
  isSolid(vx: number, vy: number, vz: number): boolean;
  treesNear(x: number, z: number, radius: number, out: Tree[]): Tree[];
  propsNear(x: number, z: number, radius: number, out: Prop[]): Prop[];
}

/** Samples across a footprint, per half extent: 3 gives a 7 x 7 grid. */
const GRID = 3;
/** A player whose feet are within this of the top of the thing is standing on it, not in it. */
const PLAYER_CLEARANCE = 0.1;
/** Props and trees are looked for this far past the footprint. */
const PROP_SEARCH_MARGIN = 6;
const TREE_SEARCH_MARGIN = 3;

/**
 * Works out where a placement goes and whether it can. Reuses one plan object
 * (it is asked every frame while an item is held), so read it before asking
 * again.
 */
export class PlacementPlanner {
  private readonly result: PlacementPlan = { x: 0, y: 0, z: 0, yaw: 0, valid: false, block: "none" };
  private readonly trees: Tree[] = [];
  private readonly props: Prop[] = [];

  constructor(
    private readonly world: PlacementWorld,
    private readonly trampolines: Pick<TrampolineField, "items">,
  ) {}

  /** Plans `spec` centred on the aimed point (aimX, aimZ). */
  plan(spec: PlacementSpec, aimX: number, aimZ: number, player: PlacementPlayer): PlacementPlan {
    const { world } = this;
    const plan = this.result;
    const yaw = spec.facesPlayer ? Math.atan2(player.x - aimX, player.z - aimZ) : 0;
    // three.js turns +X to (cos, -sin) about Y.
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const reach = GRID * GRID;

    // Stand on the highest ground under the footprint, so no edge is buried.
    let high = -Infinity;
    let low = Infinity;
    for (let i = -GRID; i <= GRID; i++) {
      for (let j = -GRID; j <= GRID; j++) {
        if (spec.round && i * i + j * j > reach) continue;
        const u = (i / GRID) * spec.halfX;
        const v = (j / GRID) * spec.halfZ;
        const ground =
          world.surfaceHeightVoxels(
            Math.floor((aimX + u * cos + v * sin) / VOXEL_SIZE),
            Math.floor((aimZ - u * sin + v * cos) / VOXEL_SIZE),
          ) * VOXEL_SIZE;
        if (ground > high) high = ground;
        if (ground < low) low = ground;
      }
    }
    const base = high;

    // Anything solid above the base and below the top is inside it: an
    // overhang, a ledge, the wall of a dug hole.
    let buried = false;
    for (let i = -GRID; i <= GRID && !buried; i++) {
      for (let j = -GRID; j <= GRID && !buried; j++) {
        if (spec.round && i * i + j * j > reach) continue;
        const u = (i / GRID) * spec.halfX;
        const v = (j / GRID) * spec.halfZ;
        const vx = Math.floor((aimX + u * cos + v * sin) / VOXEL_SIZE);
        const vz = Math.floor((aimZ - u * sin + v * cos) / VOXEL_SIZE);
        for (let y = base + VOXEL_SIZE * 0.5; y < base + spec.height; y += VOXEL_SIZE) {
          if (world.isSolid(vx, Math.floor(y / VOXEL_SIZE), vz)) {
            buried = true;
            break;
          }
        }
      }
    }

    const bound = spec.round ? spec.halfX : Math.hypot(spec.halfX, spec.halfZ);
    let block: PlacementBlock = "none";
    if (buried) block = "buried";
    else if (base - low > spec.maxGap) block = "floating";
    else if (this.crowded(aimX, aimZ, bound)) block = "occupied";
    else if (
      Math.hypot(player.x - aimX, player.z - aimZ) < bound + player.halfWidth &&
      player.y < base + spec.height - PLAYER_CLEARANCE
    ) {
      // Not on top of yourself: standing inside the footprint below the top
      // would leave you embedded in it.
      block = "player";
    }

    plan.x = aimX;
    plan.y = base;
    plan.z = aimZ;
    plan.yaw = yaw;
    plan.valid = block === "none";
    plan.block = block;
    return plan;
  }

  /** Whether a mat, a prop or a tree is in the way of a footprint of radius `bound` at (x, z). */
  private crowded(x: number, z: number, bound: number): boolean {
    for (const mat of this.trampolines.items) {
      if (Math.hypot(mat.x - x, mat.z - z) < TRAMPOLINE_RADIUS + bound) return true;
    }
    for (const prop of this.world.propsNear(x, z, bound + PROP_SEARCH_MARGIN, this.props)) {
      // Zero height is a prop you can walk through (it cannot be aimed at either).
      if (prop.height > 0 && Math.hypot(prop.x - x, prop.z - z) < prop.radius + bound) return true;
    }
    for (const tree of this.world.treesNear(x, z, bound + TREE_SEARCH_MARGIN, this.trees)) {
      if (Math.hypot(tree.x - x, tree.z - z) < tree.trunkRadiusMeters + bound) return true;
    }
    return false;
  }
}
