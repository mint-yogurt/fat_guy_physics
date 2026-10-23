import { describe, expect, it } from "vitest";

import { BuildField, PIECE_SPECS } from "../items/building.ts";
import { PiecePlanner, createSurfaceAim, type PieceWorld } from "../items/buildPlan.ts";
import { ItemType } from "../items/inventory.ts";
import { PlacementOrientation } from "../items/placementControl.ts";
import { FIXED_TIMESTEP } from "./constants.ts";
import { CLIMB_REGRAB_DELAY } from "./climb.ts";
import { Player, createPlayerInput, type PlayerInput } from "./player.ts";
import { SceneSolidQuery } from "./sceneQuery.ts";

/**
 * A floor at y = 0, and a block 3m high from x = 1 on: a cliff facing -X with
 * a ledge on top. A ladder stands on its face.
 */
const CLIFF_X = 1;
const CLIFF_TOP = 3;
const terrain = {
  isSolid: (vx: number, vy: number): boolean => vy < 0 || (vx >= CLIFF_X * 10 && vy < CLIFF_TOP * 10),
};

const pieceWorld: PieceWorld = {
  isSolid: terrain.isSolid,
  treesNear: (_x, _z, _r, out) => {
    out.length = 0;
    return out;
  },
  propsNear: (_x, _z, _r, out) => {
    out.length = 0;
    return out;
  },
};

function setUp(): { player: Player; field: BuildField; query: SceneSolidQuery } {
  const field = new BuildField();
  const planner = new PiecePlanner(pieceWorld, field);
  const aim = createSurfaceAim();
  aim.valid = true;
  aim.x = CLIFF_X;
  aim.y = 1.9;
  aim.z = 0;
  aim.nx = -1;
  aim.ny = 0;
  aim.nz = 0;
  const ladder = PIECE_SPECS[ItemType.Ladder];
  if (ladder === undefined) throw new Error("no ladder spec");
  const plan = planner.plan(ladder, aim, { x: 50, y: 0, z: 50, halfWidth: 0.55 }, 1, 0, new PlacementOrientation());
  expect(plan.valid).toBe(true);
  field.place(ItemType.Ladder, plan.x, plan.y, plan.z, { x: plan.qx, y: plan.qy, z: plan.qz, w: plan.qw }, true);

  const query = new SceneSolidQuery(terrain);
  const player = new Player(0, 0, 0);
  player.rails = field;
  // Looking along +X, at the cliff.
  player.setLook(0, 0);
  return { player, field, query };
}

function run(player: Player, query: SceneSolidQuery, input: PlayerInput, seconds: number): void {
  const steps = Math.round(seconds / FIXED_TIMESTEP);
  for (let i = 0; i < steps; i++) {
    player.update(input, FIXED_TIMESTEP, query, () => 0);
    input.jumpPressed = false;
  }
}

describe("climbing a ladder", () => {
  it("takes hold when walking into it, and goes up and over onto the ledge", () => {
    const { player, query } = setUp();
    const input = createPlayerInput();
    input.moveZ = 1;
    run(player, query, input, 0.4);
    expect(player.climbing).toBe(true);
    // Drawn in to the rungs, a body's width off the cliff.
    expect(player.x).toBeGreaterThan(0.2);
    expect(player.x).toBeLessThan(0.5);

    run(player, query, input, 0.4);
    expect(player.y).toBeGreaterThan(1);
    expect(player.climbing).toBe(true);

    run(player, query, input, 3);
    expect(player.climbing).toBe(false);
    // On the ledge, standing.
    expect(player.y).toBeCloseTo(CLIFF_TOP, 1);
    expect(player.x).toBeGreaterThan(CLIFF_X - 0.5);
  });

  it("goes only up and down: sideways keys do nothing", () => {
    const { player, query } = setUp();
    const input = createPlayerInput();
    input.moveZ = 1;
    run(player, query, input, 0.8);
    expect(player.climbing).toBe(true);
    const z = player.z;
    input.moveZ = 0;
    input.moveX = 1;
    run(player, query, input, 0.6);
    expect(player.z).toBeCloseTo(z, 2);
  });

  it("lets go with a jump, and does not grab again straight away", () => {
    const { player, query } = setUp();
    const input = createPlayerInput();
    input.moveZ = 1;
    run(player, query, input, 0.8);
    expect(player.climbing).toBe(true);
    const heightBefore = player.y;

    input.jumpPressed = true;
    run(player, query, input, 1 / 60);
    expect(player.climbing).toBe(false);
    expect(player.vy).toBeGreaterThan(0);
    // Still holding forward, but the grab waits.
    run(player, query, input, CLIMB_REGRAB_DELAY / 2);
    expect(player.climbing).toBe(false);
    expect(player.y).toBeGreaterThan(heightBefore - 0.1);
  });

  it("comes down the bottom and stands on the ground", () => {
    const { player, query } = setUp();
    const input = createPlayerInput();
    input.moveZ = 1;
    run(player, query, input, 0.8);
    expect(player.climbing).toBe(true);
    input.moveZ = -1;
    run(player, query, input, 2.5);
    expect(player.climbing).toBe(false);
    expect(player.y).toBeCloseTo(0, 1);
  });

  it("does not take hold when facing away", () => {
    const { player, query } = setUp();
    player.setLook(180, 0);
    const input = createPlayerInput();
    input.moveZ = 1;
    run(player, query, input, 0.5);
    expect(player.climbing).toBe(false);
  });

  it("falls when the ladder is picked up under it", () => {
    const { player, field, query } = setUp();
    const input = createPlayerInput();
    input.moveZ = 1;
    run(player, query, input, 0.8);
    expect(player.climbing).toBe(true);
    const piece = field.pieces[0];
    if (piece === undefined) throw new Error("no ladder");
    field.remove(piece);
    input.moveZ = 0;
    run(player, query, input, 0.3);
    expect(player.climbing).toBe(false);
    expect(player.vy).toBeLessThan(0);
  });

  it("lets go when the player tucks into a ball", () => {
    const { player, query } = setUp();
    const input = createPlayerInput();
    input.moveZ = 1;
    run(player, query, input, 0.6);
    expect(player.climbing).toBe(true);
    player.toggleMode(query);
    run(player, query, input, 0.1);
    expect(player.climbing).toBe(false);
  });
});
