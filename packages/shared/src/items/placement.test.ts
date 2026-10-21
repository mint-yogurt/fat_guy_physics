import { describe, expect, it } from "vitest";

import { VOXEL_SIZE } from "../sim/constants.ts";
import type { Prop, Tree } from "../sim/world.ts";
import { ItemType } from "./inventory.ts";
import {
  PLACEMENTS,
  PlacementPlanner,
  placementOf,
  type PlacementPlayer,
  type PlacementWorld,
} from "./placement.ts";
import { TRAMPOLINE_HEIGHT, TRAMPOLINE_RADIUS, TrampolineField } from "./trampoline.ts";

/** Flat ground at `level` voxels, with optional features. */
class FlatWorld implements PlacementWorld {
  props: Prop[] = [];
  trees: Tree[] = [];
  /** Voxel columns (inclusive x range) that stand taller than the plain. */
  step: { fromX: number; level: number } | undefined;
  /** An extra solid block floating over the plain. */
  ledge: { vx: number; vy: number; vz: number } | undefined;

  constructor(readonly level = 10) {}

  surfaceHeightVoxels(vx: number): number {
    return this.step !== undefined && vx >= this.step.fromX ? this.step.level : this.level;
  }
  isSolid(vx: number, vy: number, vz: number): boolean {
    if (vy < this.surfaceHeightVoxels(vx)) return true;
    const ledge = this.ledge;
    return ledge !== undefined && ledge.vx === vx && ledge.vy === vy && ledge.vz === vz;
  }
  treesNear(_x: number, _z: number, _r: number, out: Tree[]): Tree[] {
    out.length = 0;
    out.push(...this.trees);
    return out;
  }
  propsNear(_x: number, _z: number, _r: number, out: Prop[]): Prop[] {
    out.length = 0;
    out.push(...this.props);
    return out;
  }
}

const faraway: PlacementPlayer = { x: 100, y: 0, z: 100, halfWidth: 0.3 };

function setup(world = new FlatWorld()): { world: FlatWorld; mats: TrampolineField; planner: PlacementPlanner } {
  const mats = new TrampolineField();
  return { world, mats, planner: new PlacementPlanner(world, mats) };
}

describe("placement specs", () => {
  it("covers the mat and every container, and nothing else yet", () => {
    expect(placementOf(ItemType.Trampoline)?.round).toBe(true);
    expect(placementOf(ItemType.PresentSmall)?.facesPlayer).toBe(true);
    expect(placementOf(ItemType.CandyBucket)?.hideHeldInFirstPerson).toBe(true);
    expect(placementOf(ItemType.Stick)).toBeUndefined();
    expect(placementOf(undefined)).toBeUndefined();
    expect(Object.keys(PLACEMENTS)).toHaveLength(4);
  });
});

describe("placement planner", () => {
  it("accepts open flat ground, standing on it", () => {
    const { planner } = setup();
    const plan = planner.plan(PLACEMENTS[ItemType.Trampoline]!, 5, 5, faraway);
    expect(plan.valid).toBe(true);
    expect(plan.block).toBe("none");
    expect(plan.y).toBeCloseTo(10 * VOXEL_SIZE);
  });

  it("stands on the highest ground under the footprint", () => {
    const world = new FlatWorld();
    world.step = { fromX: Math.floor(5 / VOXEL_SIZE), level: 12 };
    const { planner } = setup(world);
    const plan = planner.plan(PLACEMENTS[ItemType.Trampoline]!, 5, 5, faraway);
    expect(plan.y).toBeCloseTo(12 * VOXEL_SIZE);
  });

  it("refuses a mat that would hang over a drop", () => {
    const world = new FlatWorld();
    world.step = { fromX: Math.floor(5 / VOXEL_SIZE), level: 10 + Math.ceil(2 / VOXEL_SIZE) };
    const { planner } = setup(world);
    const plan = planner.plan(PLACEMENTS[ItemType.Trampoline]!, 5, 5, faraway);
    expect(plan.valid).toBe(false);
    expect(plan.block).toBe("floating");
  });

  it("refuses a spot with something solid inside it", () => {
    const world = new FlatWorld();
    world.ledge = {
      vx: Math.floor(5 / VOXEL_SIZE),
      vy: 10 + 1,
      vz: Math.floor(5 / VOXEL_SIZE),
    };
    const { planner } = setup(world);
    const plan = planner.plan(PLACEMENTS[ItemType.Trampoline]!, 5, 5, faraway);
    expect(plan.valid).toBe(false);
    expect(plan.block).toBe("buried");
  });

  it("refuses to overlap another mat, but not to sit beside one", () => {
    const { planner, mats } = setup();
    mats.place(5, 10 * VOXEL_SIZE, 5);
    const spec = PLACEMENTS[ItemType.Trampoline]!;
    expect(planner.plan(spec, 5 + TRAMPOLINE_RADIUS * 1.5, 5, faraway).block).toBe("occupied");
    expect(planner.plan(spec, 5 + TRAMPOLINE_RADIUS * 2.1, 5, faraway).valid).toBe(true);
  });

  it("refuses to bury the player, but allows standing clear of it", () => {
    const { planner } = setup();
    const spec = PLACEMENTS[ItemType.Trampoline]!;
    const ground = 10 * VOXEL_SIZE;
    expect(planner.plan(spec, 5, 5, { x: 5.5, y: ground, z: 5, halfWidth: 0.3 }).block).toBe("player");
    expect(
      planner.plan(spec, 5, 5, { x: 5.5, y: ground + TRAMPOLINE_HEIGHT + 0.5, z: 5, halfWidth: 0.3 }).valid,
    ).toBe(true);
    expect(planner.plan(spec, 5, 5, { x: 9, y: ground, z: 5, halfWidth: 0.3 }).valid).toBe(true);
  });

  it("refuses a tree trunk and a standing prop, but not a flat one", () => {
    const world = new FlatWorld();
    const { planner } = setup(world);
    const spec = PLACEMENTS[ItemType.PresentSmall]!;

    world.trees = [{ x: 5, z: 5, trunkRadiusMeters: 0.4 } as Tree];
    expect(planner.plan(spec, 5.3, 5, faraway).block).toBe("occupied");
    world.trees = [];

    world.props = [{ x: 5, z: 5, radius: 0.5, height: 1 } as Prop];
    expect(planner.plan(spec, 5.4, 5, faraway).block).toBe("occupied");
    world.props = [{ x: 5, z: 5, radius: 0.5, height: 0 } as Prop];
    expect(planner.plan(spec, 5.4, 5, faraway).valid).toBe(true);
  });

  it("turns a container to face the player, and leaves a mat alone", () => {
    const { planner } = setup();
    const player: PlacementPlayer = { x: 0, y: 0, z: 0, halfWidth: 0.3 };
    const present = planner.plan(PLACEMENTS[ItemType.PresentBig]!, 5, 0, player);
    expect(present.yaw).toBeCloseTo(Math.atan2(-5, 0));
    expect(planner.plan(PLACEMENTS[ItemType.Trampoline]!, 5, 0, player).yaw).toBe(0);
  });
});
