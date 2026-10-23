import { Group, Scene } from "three/webgpu";
import { describe, expect, it } from "vitest";

import { BuildField } from "@fgp/shared/items/building";
import { ItemType } from "@fgp/shared/items/inventory";
import { TrunkQuery } from "@fgp/shared/items/snowball";
import { SceneSolidQuery, type OrientedSolid } from "@fgp/shared/sim/sceneQuery";
import type { World } from "@fgp/shared/sim/world";

import type { PieceMeshes } from "../render/pieceMesh.ts";
import { BuildSystem } from "./buildSystem.ts";
import { BuildPieceRopeBody } from "./ropeBodies.ts";
import type { LogSystem } from "./logSystem.ts";
import { PhysicsWorld } from "./physicsWorld.ts";

/**
 * The build system against a real Jolt and a flat floor at y = 0: pieces put
 * down fall and come to rest, a fixed piece stays up for as long as it is held
 * and drops when it is not, and only a piece at rest is something to stand on.
 */

const STEP = 1 / 120;

/** A big flat quad at y = 0 as x, y, z triples (top face up: Jolt ignores the back of a triangle), for Jolt's terrain. */
function floorVertices(): Float32Array {
  const size = 60;
  const corners = [
    [-size, -size],
    [size, size],
    [size, -size],
    [-size, -size],
    [-size, size],
    [size, size],
  ];
  const out = new Float32Array(corners.length * 3);
  corners.forEach(([x, z], i) => {
    out[i * 3] = x ?? 0;
    out[i * 3 + 1] = 0;
    out[i * 3 + 2] = z ?? 0;
  });
  return out;
}

class FakeWorld {
  /** Solid at and below y = 0, and wherever `wall` says. */
  wall: ((vx: number, vy: number, vz: number) => boolean) | undefined;
  readonly pendingCount = 0;
  isSolid(vx: number, vy: number, vz: number): boolean {
    return vy < 0 || (this.wall?.(vx, vy, vz) ?? false);
  }
  treesNear(_x: number, _z: number, _r: number, out: unknown[]): unknown[] {
    out.length = 0;
    return out;
  }
  propsNear(_x: number, _z: number, _r: number, out: unknown[]): unknown[] {
    out.length = 0;
    return out;
  }
}

const fakeLogs = {
  keepAround: (): void => undefined,
  ensureStaticAround: (): void => undefined,
} as unknown as LogSystem;

const fakeMeshes = { make: () => new Group() } as unknown as PieceMeshes;

async function setUp(): Promise<{
  physics: PhysicsWorld;
  field: BuildField;
  system: BuildSystem;
  query: SceneSolidQuery;
  world: FakeWorld;
  run: (seconds: number) => void;
}> {
  const physics = await PhysicsWorld.create();
  physics.addTerrainBody(1, 0, 0, 0, floorVertices(), 6);
  const world = new FakeWorld();
  const field = new BuildField();
  const query = new SceneSolidQuery(world as unknown as World);
  const system = new BuildSystem(field, world as unknown as World, query, new Scene(), fakeMeshes, 60);
  system.attachPhysics(physics, fakeLogs);
  const run = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      system.update(STEP, 0, 0, 0);
      physics.step(STEP);
    }
  };
  return { physics, field, system, query, world, run };
}

const FLAT = { x: 0, y: 0, z: 0, w: 1 };

describe("building pieces under physics", () => {
  it("drops a loose sheet of plywood and lets it come to rest, then it is something to stand on", async () => {
    const { field, query, run } = await setUp();
    const sheet = field.place(ItemType.Plywood, 0, 1.5, 0, FLAT, false)!;
    const before = field.version;

    run(0.2);
    expect(sheet.settled).toBe(false);
    // Falling pieces are not walkable.
    expect(query.pieces).not.toContain(sheet.solid);

    run(4);
    expect(sheet.settled).toBe(true);
    // Lying on its slab: half its 10cm on the floor.
    expect(sheet.y).toBeGreaterThan(0.03);
    expect(sheet.y).toBeLessThan(0.08);
    expect(query.pieces).toContain(sheet.solid);
    // Where it came to rest is saved.
    expect(field.version).toBeGreaterThan(before);
    // The player's sweep sees it: a point inside the slab is solid.
    expect(query.isSolid(0, 0, 0)).toBe(true);
  });

  it("keeps a fixed ladder where it is put, and it is not walked into", async () => {
    const { field, query, run, world } = await setUp();
    // The ladder is held by a wall of voxels at x >= 1.
    world.wall = (vx) => vx >= 10;
    const ladder = field.place(ItemType.Ladder, 0.96, 2, 0, { x: 0, y: 1, z: 0, w: 0 }, true)!;
    run(3);
    expect(ladder.y).toBeCloseTo(2, 5);
    expect(ladder.fixed).toBe(true);
    expect(query.pieces).not.toContain(ladder.solid);
  });

  it("lets a ladder fall when the wall it hangs on goes", async () => {
    const { field, run, world } = await setUp();
    world.wall = (vx) => vx >= 10;
    const ladder = field.place(ItemType.Ladder, 0.96, 2, 0, { x: 0, y: 1, z: 0, w: 0 }, true)!;
    run(1.5);
    expect(ladder.fixed).toBe(true);
    world.wall = undefined;
    run(4);
    expect(ladder.fixed).toBe(false);
    // Down on the ground, flat or leaning, and still.
    expect(ladder.y).toBeLessThan(1);
    expect(ladder.settled).toBe(true);
  });

  it("stacks a plank on a plank", async () => {
    const { field, run } = await setUp();
    const lower = field.place(ItemType.Plywood, 0, 0.06, 0, FLAT, false)!;
    run(1.5);
    const upper = field.place(ItemType.Plywood, 0, lower.y + 0.2, 0, FLAT, false)!;
    run(3);
    expect(upper.settled).toBe(true);
    expect(upper.y).toBeGreaterThan(lower.y + 0.08);
    expect(upper.y).toBeLessThan(lower.y + 0.14);
  });

  it("wakes a resting piece when disturbed, and settles it again", async () => {
    const { field, system, run } = await setUp();
    const sheet = field.place(ItemType.Toobifer, 0, 0.2, 0, FLAT, false)!;
    run(3);
    expect(sheet.settled).toBe(true);
    system.disturb(0, 0, 0, 1);
    expect(sheet.settled).toBe(false);
    run(3);
    expect(sheet.settled).toBe(true);
  });

  it("lists every piece near for flying things to hit, walkable or not, and a rope tied to one follows it", async () => {
    const physics = await PhysicsWorld.create();
    physics.addTerrainBody(1, 0, 0, 0, floorVertices(), 6);
    const world = new FakeWorld();
    const field = new BuildField();
    const query = new SceneSolidQuery(world as unknown as World);
    const flight: OrientedSolid[] = [];
    const system = new BuildSystem(field, world as unknown as World, query, new Scene(), fakeMeshes, 60, flight);
    system.attachPhysics(physics, fakeLogs);
    const run = (seconds: number): void => {
      for (let i = 0; i < Math.round(seconds / STEP); i++) {
        system.update(STEP, 0, 0, 0);
        physics.step(STEP);
      }
    };

    world.wall = (vx) => vx >= 10;
    const ladder = field.place(ItemType.Ladder, 0.96, 2, 0, { x: 0, y: 1, z: 0, w: 0 }, true)!;
    const sheet = field.place(ItemType.Plywood, 4, 1.5, 0, FLAT, false)!;
    run(0.3);
    // The ladder is not walked into, but a snowball still hits it.
    expect(query.pieces).not.toContain(ladder.solid);
    expect(flight).toContain(ladder.solid);
    expect(flight).toContain(sheet.solid);
    const trunks = new TrunkQuery(query);
    trunks.solids.push(...flight);
    expect(trunks.isSolid(10 - 1, 20, 0)).toBe(true);

    // A string tied to the falling sheet goes where the sheet goes.
    const tie = new BuildPieceRopeBody(system, field, sheet, sheet.x + 0.4, sheet.y, sheet.z);
    const point = { x: 0, y: 0, z: 0 };
    expect(tie.tiePoint(point)).toBe(true);
    const startY = point.y;
    run(2);
    tie.tiePoint(point);
    expect(point.y).toBeLessThan(startY - 0.5);
    expect(point.x).toBeCloseTo(sheet.x + 0.4, 1);
    field.remove(sheet);
    expect(tie.tiePoint(point)).toBe(false);
  });

  it("forgets a piece taken out of the field", async () => {
    const { field, system, run } = await setUp();
    const log = field.place(ItemType.Log, 0, 1, 0, FLAT, false)!;
    run(0.1);
    expect(system.bodyCount).toBe(1);
    field.remove(log);
    run(0.1);
    expect(system.bodyCount).toBe(0);
  });

  it("brings a saved piece back asleep where it was", async () => {
    const { field, run } = await setUp();
    field.restore([
      { item: "plywood", x: 3, y: 0.05, z: 3, qx: 0, qy: 0, qz: 0, qw: 1, fixed: false },
    ]);
    run(0.5);
    const piece = field.pieces[0]!;
    expect(piece.settled).toBe(true);
    expect(piece.y).toBeCloseTo(0.05, 3);
  });
});
