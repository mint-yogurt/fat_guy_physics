import { describe, expect, it } from "vitest";

import { createMat3, matFromQuat } from "../sim/rotation.ts";
import { HitKind, createSceneHit } from "../sim/world.ts";
import { BuildField, PIECE_SPECS, createBuildHit, pieceMass, raySolid } from "./building.ts";
import { PiecePlanner, aimAtSurface, createSurfaceAim, type PieceWorld } from "./buildPlan.ts";
import { CONTAINER_ITEMS, CONTAINER_KINDS } from "./container.ts";
import { ItemType } from "./inventory.ts";
import { PLACEMENTS, placementOf } from "./placement.ts";
import { PlacementOrientation, SPIN_STEP } from "./placementControl.ts";

/** A flat world: solid below y = 0 (voxels below 0), with an optional wall of solid voxels from x onward (its face looks toward -X). */
function makeWorld(wall?: { x: number; fromY: number; toY: number }): PieceWorld & {
  solid: (vx: number, vy: number, vz: number) => boolean;
} {
  const solid = (vx: number, vy: number, vz: number): boolean => {
    void vz;
    if (vy < 0) return true;
    return wall !== undefined && vx >= wall.x * 10 && vy >= wall.fromY * 10 && vy < wall.toY * 10;
  };
  return {
    solid,
    isSolid: solid,
    treesNear: (_x, _z, _r, out) => {
      out.length = 0;
      return out;
    },
    propsNear: (_x, _z, _r, out) => {
      out.length = 0;
      return out;
    },
  };
}

const PLAYER_FAR = { x: 50, y: 0, z: 50, halfWidth: 0.55 };

function aimAt(x: number, y: number, z: number, nx: number, ny: number, nz: number) {
  const aim = createSurfaceAim();
  aim.valid = true;
  aim.x = x;
  aim.y = y;
  aim.z = z;
  aim.nx = nx;
  aim.ny = ny;
  aim.nz = nz;
  return aim;
}

/** The world direction of a piece's own axis, from the plan's quaternion. */
function axisOf(plan: { qx: number; qy: number; qz: number; qw: number }, axis: 0 | 1 | 2): [number, number, number] {
  const m = matFromQuat(plan.qx, plan.qy, plan.qz, plan.qw, createMat3());
  return [m[axis * 3] ?? 0, m[axis * 3 + 1] ?? 0, m[axis * 3 + 2] ?? 0];
}

describe("which items are building pieces", () => {
  it("makes every piece, and the mats and containers, placeable", () => {
    const items = [
      ItemType.Ladder,
      ItemType.Log,
      ItemType.Toobifer,
      ItemType.Plywood,
      ItemType.Wheel,
      ItemType.Trampoline,
      ...CONTAINER_KINDS.map((kind) => CONTAINER_ITEMS[kind]),
    ];
    expect(items).toHaveLength(9);
    for (const item of items) {
      expect(placementOf(item), String(item)).toBeDefined();
    }
  });

  it("marks only the building pieces as pieces", () => {
    for (const [item, spec] of Object.entries(PLACEMENTS)) {
      const isPiece = PIECE_SPECS[Number(item) as ItemType] !== undefined;
      expect(spec?.piece !== undefined, item).toBe(isPiece);
    }
  });

  it("has a mass for each that is sensible for wood", () => {
    const ply = PIECE_SPECS[ItemType.Plywood];
    expect(ply).toBeDefined();
    if (ply === undefined) return;
    expect(pieceMass(ply)).toBeGreaterThan(50);
    expect(pieceMass(ply)).toBeLessThan(400);
  });
});

describe("laying a piece on a surface", () => {
  it("lays plywood flat on the floor, on its underside, with its long way where the player looks", () => {
    const world = makeWorld();
    const planner = new PiecePlanner(world, new BuildField());
    const spec = PIECE_SPECS[ItemType.Plywood];
    if (spec === undefined) throw new Error("no spec");
    const plan = planner.plan(spec, aimAt(2, 0, 0, 0, 1, 0), PLAYER_FAR, 1, 0, new PlacementOrientation());
    expect(plan.valid).toBe(true);
    // Its half thickness (5cm) above the floor, plus the hair of gap.
    expect(plan.y).toBeCloseTo(0.05, 1);
    const up = axisOf(plan, 1);
    expect(up[1]).toBeCloseTo(1, 5);
    const long = axisOf(plan, 2);
    expect(Math.abs(long[0])).toBeCloseTo(1, 5);
  });

  it("stands a ladder up a wall with its back to it", () => {
    const world = makeWorld({ x: 1, fromY: 0, toY: 8 });
    const planner = new PiecePlanner(world, new BuildField());
    const spec = PIECE_SPECS[ItemType.Ladder];
    if (spec === undefined) throw new Error("no spec");
    const plan = planner.plan(spec, aimAt(1, 2, 0, -1, 0, 0), PLAYER_FAR, 1, 0, new PlacementOrientation());
    expect(plan.valid).toBe(true);
    const long = axisOf(plan, 2);
    expect(Math.abs(long[1])).toBeCloseTo(1, 5);
    // Its front (+X of the model) faces out of the wall, toward -X.
    const front = axisOf(plan, 0);
    expect(front[0]).toBeCloseTo(-1, 5);
    // Half its 8cm thickness off the wall.
    expect(plan.x).toBeCloseTo(1 - 0.04, 1);
  });

  it("turns a quarter at a time with the wheel", () => {
    const orient = new PlacementOrientation();
    orient.step(2);
    expect(orient.spin).toBeCloseTo(SPIN_STEP * 2, 6);
    orient.step(-1);
    expect(orient.spin).toBeCloseTo(SPIN_STEP, 6);
    orient.reset();
    expect(orient.spin).toBe(0);
  });

  it("spins a plank on the floor to run across the way the player looks", () => {
    const planner = new PiecePlanner(makeWorld(), new BuildField());
    const spec = PIECE_SPECS[ItemType.Toobifer];
    if (spec === undefined) throw new Error("no spec");
    const orient = new PlacementOrientation();
    orient.step(2);
    const plan = planner.plan(spec, aimAt(2, 0, 0, 0, 1, 0), PLAYER_FAR, 1, 0, orient);
    const long = axisOf(plan, 2);
    expect(Math.abs(long[0])).toBeLessThan(1e-6);
    expect(Math.abs(long[2])).toBeCloseTo(1, 5);
  });

  it("leans a ladder against a wall so it touches with its edge, not through it", () => {
    const world = makeWorld({ x: 1, fromY: 0, toY: 8 });
    const planner = new PiecePlanner(world, new BuildField());
    const spec = PIECE_SPECS[ItemType.Ladder];
    if (spec === undefined) throw new Error("no spec");
    const orient = new PlacementOrientation();
    // Mouse down 0.3 radians' worth: lean it.
    orient.drag(0, -30);
    const plan = planner.plan(spec, aimAt(1, 2, 0, -1, 0, 0), PLAYER_FAR, 1, 0, orient);
    expect(plan.valid).toBe(true);
    const long = axisOf(plan, 2);
    expect(Math.abs(long[0])).toBeGreaterThan(0.1);
    // Whichever way it leans, the nearest face of the shape is on the wall plane.
    const m = matFromQuat(plan.qx, plan.qy, plan.qz, plan.qw, createMat3());
    const reach =
      0.04 * Math.abs(m[0] ?? 0) + 0.315 * Math.abs(m[3] ?? 0) + 1.5 * Math.abs(m[6] ?? 0);
    expect(plan.x + reach).toBeCloseTo(1, 1);
  });

  it("lays a log on its side on the floor", () => {
    const planner = new PiecePlanner(makeWorld(), new BuildField());
    const spec = PIECE_SPECS[ItemType.Log];
    if (spec === undefined) throw new Error("no spec");
    const plan = planner.plan(spec, aimAt(2, 0, 0, 0, 1, 0), PLAYER_FAR, 1, 0, new PlacementOrientation());
    expect(plan.valid).toBe(true);
    // Radius 0.3 above the floor, its axis level.
    expect(plan.y).toBeCloseTo(0.3, 1);
    expect(Math.abs(axisOf(plan, 1)[1])).toBeLessThan(1e-6);
  });

  it("refuses a spot that is inside the ground", () => {
    const planner = new PiecePlanner(makeWorld(), new BuildField());
    const spec = PIECE_SPECS[ItemType.Plywood];
    if (spec === undefined) throw new Error("no spec");
    // Aimed at the floor but with the surface said to face sideways: the sheet goes into the ground.
    const plan = planner.plan(spec, aimAt(2, 0, 0, 1, 0, 0), PLAYER_FAR, 1, 0, new PlacementOrientation());
    expect(plan.valid).toBe(false);
    expect(plan.block).toBe("buried");
  });

  it("refuses a spot where the player stands", () => {
    const planner = new PiecePlanner(makeWorld(), new BuildField());
    const spec = PIECE_SPECS[ItemType.Plywood];
    if (spec === undefined) throw new Error("no spec");
    const plan = planner.plan(
      spec,
      aimAt(0, 0, 0, 0, 1, 0),
      { x: 0, y: 0, z: 0, halfWidth: 0.55 },
      1,
      0,
      new PlacementOrientation(),
    );
    expect(plan.block).toBe("player");
  });

  it("stacks on another piece, and refuses to go through it", () => {
    const world = makeWorld();
    const field = new BuildField();
    const planner = new PiecePlanner(world, field);
    const spec = PIECE_SPECS[ItemType.Plywood];
    if (spec === undefined) throw new Error("no spec");
    const first = planner.plan(spec, aimAt(2, 0, 0, 0, 1, 0), PLAYER_FAR, 1, 0, new PlacementOrientation());
    field.place(ItemType.Plywood, first.x, first.y, first.z, { x: first.qx, y: first.qy, z: first.qz, w: first.qw }, false);

    const onTop = planner.plan(spec, aimAt(2, 0.1, 0, 0, 1, 0), PLAYER_FAR, 1, 0, new PlacementOrientation());
    expect(onTop.valid).toBe(true);
    expect(onTop.y).toBeGreaterThan(0.1);

    // Aimed at the floor beside it so that the two overlap.
    const through = planner.plan(spec, aimAt(2, 0, 0.3, 0, 1, 0), PLAYER_FAR, 1, 0, new PlacementOrientation());
    expect(through.valid).toBe(false);
    expect(through.block).toBe("occupied");
  });
});

describe("what the crosshair is on", () => {
  it("prefers a piece in front of the terrain behind it", () => {
    const hit = createBuildHit();
    hit.piece = new BuildField().place(ItemType.Plywood, 0, 0, 0, { x: 0, y: 0, z: 0, w: 1 }, false);
    hit.distance = 2;
    hit.x = 2;
    hit.y = 1;
    hit.nx = 0;
    hit.ny = 1;
    hit.nz = 0;
    const scene = createSceneHit();
    scene.kind = HitKind.Terrain;
    scene.distance = 5;
    const aim = aimAtSurface({ getTree: () => undefined, getProp: () => undefined }, scene, hit, 0, 1, 0, 1, 0, 0, createSurfaceAim());
    expect(aim.valid).toBe(true);
    expect(aim.x).toBe(2);
  });

  it("takes the terrain when nothing is in front of it, with the face the ray came in through", () => {
    const scene = createSceneHit();
    scene.kind = HitKind.Terrain;
    scene.distance = 3;
    scene.normalX = -1;
    scene.normalY = 0;
    scene.normalZ = 0;
    const aim = aimAtSurface({ getTree: () => undefined, getProp: () => undefined }, scene, createBuildHit(), 0, 1, 0, 1, 0, 0, createSurfaceAim());
    expect(aim.valid).toBe(true);
    expect(aim.x).toBeCloseTo(3);
    expect(aim.nx).toBe(-1);
  });

  it("is not an aim when nothing is hit", () => {
    const aim = aimAtSurface({ getTree: () => undefined, getProp: () => undefined }, createSceneHit(), createBuildHit(), 0, 1, 0, 1, 0, 0, createSurfaceAim());
    expect(aim.valid).toBe(false);
  });
});

describe("rays against pieces", () => {
  it("hits a box and reports the face", () => {
    const field = new BuildField();
    const piece = field.place(ItemType.Plywood, 0, 1, 5, { x: 0, y: 0, z: 0, w: 1 }, false)!;
    const t = raySolid(piece.solid, 0, 1, 0, 0, 0, 1, 20);
    // Its long way (2.44) is along Z: the near face is 1.22 short of its centre.
    expect(t).toBeCloseTo(5 - 1.22, 5);
    const hit = createBuildHit();
    field.raycast(0, 1, 0, 0, 0, 1, 20, hit);
    expect(hit.piece).toBe(piece);
    expect(hit.nz).toBeCloseTo(-1);
  });

  it("hits the side and the end of a log", () => {
    const field = new BuildField();
    const log = field.place(ItemType.Log, 0, 1, 5, { x: 0, y: 0, z: 0, w: 1 }, false)!;
    // Standing upright (axis along Y): the side from the front.
    expect(raySolid(log.solid, 0, 1, 0, 0, 0, 1, 20)).toBeCloseTo(5 - 0.3, 5);
    // From above, the cap.
    expect(raySolid(log.solid, 0, 5, 5, 0, -1, 0, 20)).toBeCloseTo(4 - 0.38, 5);
  });

  it("misses past its length", () => {
    const field = new BuildField();
    const piece = field.place(ItemType.Plywood, 0, 1, 5, { x: 0, y: 0, z: 0, w: 1 }, false)!;
    expect(raySolid(piece.solid, 0, 1, 0, 0, 0, 1, 2)).toBe(-1);
  });
});

describe("what holds a fixed piece up", () => {
  it("keeps a ladder that touches the wall, and lets go of it when the wall goes", () => {
    const field = new BuildField();
    // Turned half way round so its back (-X of the model) is on the +X side, against a wall that starts at x = 1.
    const ladder = field.place(ItemType.Ladder, 0.96, 2, 0, { x: 0, y: 1, z: 0, w: 0 }, true);
    const wall = { isSolid: (vx: number) => vx >= 10, isInsideTreeOrProp: () => false };
    expect(field.looseOnes(wall, [])).toHaveLength(0);
    const gone = { isSolid: () => false, isInsideTreeOrProp: () => false };
    expect(field.looseOnes(gone, [])).toEqual([ladder]);
  });

  it("is held up by a tree or a prop as well", () => {
    const field = new BuildField();
    field.place(ItemType.Ladder, 0.96, 2, 0, { x: 0, y: 1, z: 0, w: 0 }, true);
    const trunk = { isSolid: () => false, isInsideTreeOrProp: (x: number) => x > 1 };
    expect(field.looseOnes(trunk, [])).toHaveLength(0);
  });

  it("holds a piece up by the fixed piece it touches, and drops both when that goes", () => {
    const field = new BuildField();
    // Two ladders end to end, up from the floor: the lower one stands on the ground, the upper one on the lower.
    const lower = field.place(ItemType.Ladder, 0, 1.5, 0, { x: 0.7071, y: 0, z: 0, w: 0.7071 }, true);
    const upper = field.place(ItemType.Ladder, 0, 4.5, 0, { x: 0.7071, y: 0, z: 0, w: 0.7071 }, true);
    const floor = { isSolid: (_x: number, y: number) => y < 0, isInsideTreeOrProp: () => false };
    expect(field.looseOnes(floor, [])).toHaveLength(0);
    const nothing = { isSolid: () => false, isInsideTreeOrProp: () => false };
    const loose = field.looseOnes(nothing, []);
    expect(loose).toContain(lower);
    expect(loose).toContain(upper);
  });
});

describe("saving", () => {
  it("round-trips a piece", () => {
    const field = new BuildField();
    field.place(ItemType.Plywood, 1, 2, 3, { x: 0, y: 0.38, z: 0, w: 0.9249 }, true);
    const copy = new BuildField();
    copy.restore(field.exportAll());
    expect(copy.pieces).toHaveLength(1);
    expect(copy.pieces[0]?.spec.item).toBe(ItemType.Plywood);
    expect(copy.pieces[0]?.fixed).toBe(true);
    expect(copy.pieces[0]?.x).toBe(1);
  });

  it("drops saved items it does not know", () => {
    const copy = new BuildField();
    copy.restore([{ item: "not_a_thing", x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, fixed: false }]);
    expect(copy.pieces).toHaveLength(0);
  });
});
