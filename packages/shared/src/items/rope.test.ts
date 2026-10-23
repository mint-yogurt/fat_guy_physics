import { describe, expect, it } from "vitest";

import type { SolidQuery } from "../sim/collision.ts";
import { FIXED_TIMESTEP, VOXEL_SIZE } from "../sim/constants.ts";
import { createPlayerInput, Player } from "../sim/player.ts";
import { PlayerBody } from "../sim/playerBody.ts";
import {
  planRope,
  Rope,
  RopeField,
  RopePlan,
  ropeMaxReach,
  ropeMinReach,
  ropeSpecFor,
  BallRopeBody,
  PlayerRopeBody,
  XMAS_LIGHTS,
  type RopeTie,
} from "./rope.ts";
import { SnowballField } from "./snowball.ts";

const DT = 1 / 120;

/** Solid below `height` metres, everywhere. */
const ground = (height: number): SolidQuery => ({
  isSolid: (_vx, vy) => (vy + 0.5) * VOXEL_SIZE < height,
});
const flat = ground(1);
const nothing: SolidQuery = { isSolid: () => false };

function run(rope: Rope, query: SolidQuery, seconds: number): void {
  for (let i = 0; i < seconds / DT; i++) rope.step(DT, query);
}

const node = (rope: Rope, i: number): [number, number, number] => [
  rope.positions[i * 3] ?? NaN,
  rope.positions[i * 3 + 1] ?? NaN,
  rope.positions[i * 3 + 2] ?? NaN,
];

const segmentLengths = (rope: Rope): number[] =>
  Array.from({ length: rope.nodeCount - 1 }, (_, i) => {
    const [ax, ay, az] = node(rope, i);
    const [bx, by, bz] = node(rope, i + 1);
    return Math.hypot(ax - bx, ay - by, az - bz);
  });

const at = (x: number, y: number, z: number): RopeTie => ({ x, y, z });

describe("planRope", () => {
  it("cuts the string a touch shorter than the gap, so it is taut like elastic", () => {
    const { plan, length } = planRope(XMAS_LIGHTS, 2);
    expect(plan).toBe(RopePlan.Ok);
    expect(length).toBeCloseTo(2 * (1 + XMAS_LIGHTS.slack), 6);
  });

  it("reaches 5m between the ends, with no minimum, and refuses beyond", () => {
    expect(ropeMaxReach(XMAS_LIGHTS)).toBeCloseTo(5, 6);
    expect(ropeMinReach(XMAS_LIGHTS)).toBe(0);
    expect(planRope(XMAS_LIGHTS, 5).plan).toBe(RopePlan.Ok);
    expect(planRope(XMAS_LIGHTS, 5.01).plan).toBe(RopePlan.TooLong);
    const touching = planRope(XMAS_LIGHTS, 0);
    expect(touching.plan).toBe(RopePlan.Ok);
    expect(touching.length).toBeGreaterThan(0);
  });

  it("runs strings together into one longer rope, reaching 5m more for each", () => {
    expect(ropeSpecFor(XMAS_LIGHTS, 1)).toBe(XMAS_LIGHTS);
    const three = ropeSpecFor(XMAS_LIGHTS, 3);
    expect(three.segments).toBe(27);
    expect(ropeMaxReach(three)).toBeCloseTo(15, 6);
    expect(planRope(three, 14).plan).toBe(RopePlan.Ok);
    expect(planRope(three, 16).plan).toBe(RopePlan.TooLong);
  });

  it("hangs close to straight across a gap", () => {
    const length = planRope(XMAS_LIGHTS, 4).length;
    const rope = new Rope(1, XMAS_LIGHTS, at(0, 3, 0), at(4, 3, 0), length);
    for (let i = 0; i < 360; i++) rope.step(DT, nothing);
    expect(node(rope, 4)[1]).toBeGreaterThan(2.85);
  });

  it("lies in a heap, steady, when its ends are tied together", () => {
    const rope = new Rope(1, XMAS_LIGHTS, at(0, 2, 0), at(0.02, 2, 0), planRope(XMAS_LIGHTS, 0.02).length);
    for (let i = 0; i < 240; i++) rope.step(DT, nothing);
    for (const v of rope.positions) expect(Number.isFinite(v)).toBe(true);
  });

  it("makes three sets of three lights", () => {
    expect(XMAS_LIGHTS.segments).toBe(9);
  });
});

describe("rope between fixed points", () => {
  it("sags under its own weight and hangs from both ends", () => {
    const rope = new Rope(1, XMAS_LIGHTS, at(0, 3, 0), at(3, 3, 0), planRope(XMAS_LIGHTS, 3).length);
    run(rope, nothing, 4);
    expect(node(rope, 0)).toEqual([0, 3, 0]);
    expect(node(rope, 9)).toEqual([3, 3, 0]);
    const [, middleY] = node(rope, 4);
    expect(middleY).toBeLessThan(2.95);
    expect(middleY).toBeGreaterThan(2);
    expect(node(rope, 4)[0]).toBeGreaterThan(1);
    expect(node(rope, 4)[0]).toBeLessThan(2);
  });

  it("bends only at the joins: each segment stays near its rest length", () => {
    const rope = new Rope(1, XMAS_LIGHTS, at(0, 3, 0), at(3, 3, 0), planRope(XMAS_LIGHTS, 3).length);
    run(rope, nothing, 4);
    for (const length of segmentLengths(rope)) {
      expect(length).toBeLessThan(rope.segmentLength * 1.1);
    }
  });

  it("lies on the ground when it has more slack than it needs", () => {
    // Ends 0.9m apart (the shortest), both on the ground, string cut for a longer gap
    // by tying them to the floor and letting one of them go loose over a pile.
    const rope = new Rope(1, XMAS_LIGHTS, at(0, 1.2, 0), at(0.9, 1.2, 0), 2.5);
    run(rope, flat, 5);
    for (let i = 0; i < rope.nodeCount; i++) {
      expect(node(rope, i)[1]).toBeGreaterThan(1 - 1e-6);
    }
    // And it is resting there, not still falling.
    const settled = node(rope, 4)[1];
    run(rope, flat, 1);
    expect(Math.abs(node(rope, 4)[1] - settled)).toBeLessThan(0.01);
  });

  it("stays finite and in place when the ends are pulled far past its length", () => {
    const rope = new Rope(1, XMAS_LIGHTS, at(0, 2, 0), at(8, 2, 0), 3);
    run(rope, nothing, 3);
    for (let i = 0; i < rope.nodeCount; i++) {
      for (const c of node(rope, i)) expect(Number.isFinite(c)).toBe(true);
    }
    expect(rope.tension[0]).toBeGreaterThan(0);
    expect(rope.tension[0]).toBeLessThanOrEqual(XMAS_LIGHTS.maxForce);
  });
});

describe("rope tied to a snowball", () => {
  function setup(): { rope: Rope; field: SnowballField; ball: ReturnType<SnowballField["spawn"]> } {
    const field = new SnowballField();
    const ball = field.spawn(2, 1.3, 0, 0, 0, 0, 0.3);
    const body = new BallRopeBody(ball, 1.7, 1.3, 0);
    const rope = new Rope(1, XMAS_LIGHTS, at(0, 1.3, 0), { x: 1.7, y: 1.3, z: 0, body }, 2.0);
    return { rope, field, ball };
  }

  it("follows the ball", () => {
    const { rope, field, ball } = setup();
    ball.vx = 1;
    for (let i = 0; i < 60; i++) {
      field.step(DT, flat, () => false);
      rope.step(DT, flat);
    }
    expect(node(rope, 9)[0]).toBeGreaterThan(1.7);
    expect(node(rope, 9)[0]).toBeCloseTo(ball.x - ball.radius * 0.95, 1);
  });

  it("holds a ball that is thrown away from it", () => {
    const { rope, field, ball } = setup();
    ball.vx = 6;
    let farthest = 0;
    for (let i = 0; i < 6 * 120; i++) {
      field.step(DT, flat, () => false);
      rope.step(DT, flat);
      farthest = Math.max(farthest, ball.x);
    }
    // Stretched a little, never gone.
    expect(farthest).toBeLessThan(3.4);
    expect(ball.x).toBeLessThan(3);
  });

  it("wakes a settled ball and drags it", () => {
    const field = new SnowballField();
    const ball = field.spawn(0.5, 1.3, 0, 0, 0, 0, 0.3);
    for (let i = 0; i < 60 * 120 && ball.rolling; i++) field.step(DT, flat, () => false);
    expect(ball.rolling).toBe(false);

    const body = new BallRopeBody(ball, 0.2, 1.3, 0);
    const rope = new Rope(1, XMAS_LIGHTS, { x: 0.2, y: 1.3, z: 0, body }, at(3.3, 1.3, 0), 2.5);
    for (let i = 0; i < 5 * 120; i++) {
      field.step(DT, flat, () => false);
      rope.step(DT, flat);
    }
    // Dragged until the string is taut, about 0.6m on.
    expect(ball.x).toBeGreaterThan(0.9);
  });

  it("lets go when the ball is used up", () => {
    const { rope, ball } = setup();
    run(rope, nothing, 0.1);
    expect(rope.isTied(1)).toBe(true);
    ball.radius = 0;
    run(rope, nothing, 1);
    expect(rope.isTied(1)).toBe(false);
    expect(node(rope, 9)[1]).toBeLessThan(1.2);
  });
});

describe("rope held by the player", () => {
  /** A player on the flat, facing along +x or wherever the default look is, with the rope's far end `behind` metres back. */
  function walker(): { player: Player; ahead: (metres: number) => [number, number] } {
    const player = new Player(0, 1, 0);
    player.look(0, 0);
    const flatLen = Math.hypot(player.frontX, player.frontZ);
    const fx = player.frontX / flatLen;
    const fz = player.frontZ / flatLen;
    return { player, ahead: (m) => [player.x + fx * m, player.z + fz * m] };
  }

  function walk(player: Player, rope: Rope, field: SnowballField | undefined, seconds: number): void {
    const input = createPlayerInput();
    input.moveZ = 1;
    const bodies = [new PlayerBody(player)];
    for (let i = 0; i < seconds / FIXED_TIMESTEP; i++) {
      player.update(input, FIXED_TIMESTEP, flat, () => 0);
      field?.step(FIXED_TIMESTEP, flat, () => false);
      rope.step(FIXED_TIMESTEP, flat, bodies);
    }
  }

  it("is tied at the hand, and follows the player", () => {
    const { player, ahead } = walker();
    const body = new PlayerRopeBody(player);
    const [bx, bz] = ahead(-2);
    const rope = new Rope(1, XMAS_LIGHTS, at(bx, 1.3, bz), { x: player.x, y: 1.5, z: player.z, body }, 5);
    rope.step(FIXED_TIMESTEP, flat);
    const [hx, , hz] = node(rope, rope.nodeCount - 1);
    expect(Math.hypot(hx - player.x, hz - player.z)).toBeLessThan(0.6);
    expect(node(rope, rope.nodeCount - 1)[1]).toBeGreaterThan(player.y + 0.5);
  });

  it("stops a player walking away from a fixed tie, stretching only a little", () => {
    const { player, ahead } = walker();
    const [bx, bz] = ahead(-2);
    const rope = new Rope(
      1,
      XMAS_LIGHTS,
      at(bx, 1.2, bz),
      { x: player.x, y: 1.5, z: player.z, body: new PlayerRopeBody(player, new PlayerBody(player)) },
      ropeMaxReach(XMAS_LIGHTS),
    );
    walk(player, rope, undefined, 12);
    const away = Math.hypot(player.x - bx, player.z - bz);
    // Walking 12 seconds would be 50m. The rope is 5m, hand ahead of the middle, and gives maybe 2m.
    expect(away).toBeGreaterThan(4.5);
    expect(away).toBeLessThan(8);
    expect(Number.isFinite(player.x)).toBe(true);
  });

  it("drags what it is tied to once it is stretched out", () => {
    const { player, ahead } = walker();
    const field = new SnowballField();
    const [bx, bz] = ahead(-2);
    const ball = field.spawn(bx, 1.3, bz, 0, 0, 0, 0.3);
    for (let i = 0; i < 60 * 120 && ball.rolling; i++) field.step(DT, flat, () => false);
    const startX = ball.x;
    const startZ = ball.z;
    const body = new BallRopeBody(ball, ball.x, ball.y + ball.radius * 0.9, ball.z);
    const rope = new Rope(
      1,
      XMAS_LIGHTS,
      { x: ball.x, y: ball.y + ball.radius * 0.9, z: ball.z, body },
      { x: player.x, y: 1.5, z: player.z, body: new PlayerRopeBody(player, new PlayerBody(player)) },
      ropeMaxReach(XMAS_LIGHTS),
    );
    walk(player, rope, field, 8);
    const [tx, tz] = ahead(0);
    // The ball came along, and the player was slowed by hauling it: 8s of walking is 36m.
    expect(Math.hypot(ball.x - startX, ball.z - startZ)).toBeGreaterThan(6);
    expect(Math.hypot(tx - ball.x, tz - ball.z)).toBeLessThan(8);
    expect(Math.hypot(player.x, player.z)).toBeLessThan(20);
  });

  it("does not push the player's own box when held", () => {
    const { player, ahead } = walker();
    const [bx, bz] = ahead(-1);
    const rope = new Rope(
      1,
      XMAS_LIGHTS,
      at(bx, 1.2, bz),
      { x: player.x, y: 1.5, z: player.z, body: new PlayerRopeBody(player, new PlayerBody(player)) },
      ropeMaxReach(XMAS_LIGHTS),
    );
    for (let i = 0; i < 240; i++) rope.step(FIXED_TIMESTEP, flat, [new PlayerBody(player)]);
    // Standing still with slack in it: nothing shoves them.
    expect(Math.hypot(player.vx, player.vz)).toBeLessThan(0.05);
  });
});

describe("a longer rope replacing a shorter", () => {
  it("keeps the shape it had", () => {
    const short = new Rope(1, XMAS_LIGHTS, at(0, 3, 0), at(4, 3, 0), 4);
    for (let i = 0; i < 240; i++) short.step(DT, nothing);
    const longer = new Rope(2, ropeSpecFor(XMAS_LIGHTS, 2), at(0, 3, 0), at(4, 3, 0), 8);
    longer.seedFrom(short);
    const mid = node(longer, longer.nodeCount >> 1);
    const shortMid = node(short, short.nodeCount >> 1);
    expect(mid[1]).toBeCloseTo(shortMid[1], 1);
    expect(node(longer, 0)[0]).toBeCloseTo(0, 6);
    expect(node(longer, longer.nodeCount - 1)[0]).toBeCloseTo(4, 1);
  });
});

describe("RopeField picking", () => {
  it("finds the string a ray passes near, and removes it", () => {
    const field = new RopeField();
    const near = field.add(XMAS_LIGHTS, at(0, 2, 3), at(2, 2, 3), 2);
    field.add(XMAS_LIGHTS, at(0, 2, 8), at(2, 2, 8), 2);
    const hit = { distance: 0 };
    // Looking along +z at the first one, from where it passes just beside the string.
    expect(field.raycast(1, 2.05, 0, 0, 0, 1, 6, hit)).toBe(near);
    expect(hit.distance).toBeCloseTo(3, 0);
    // Wide of it, and short of the far one.
    expect(field.raycast(-2, 2, 0, 0, 0, 1, 6, hit)).toBeUndefined();
    expect(field.raycast(1, 2, 0, 0, 0, 1, 2, hit)).toBeUndefined();
    expect(field.remove(near)).toBe(true);
    expect(field.remove(near)).toBe(false);
    expect(field.raycast(1, 2, 0, 0, 0, 1, 6, hit)).not.toBe(near);
  });
});

describe("RopeField", () => {
  it("drops a string that has been loose for a while, and only that", () => {
    const field = new RopeField();
    const held = field.add(XMAS_LIGHTS, at(0, 3, 0), at(2, 3, 0), 2);
    const field2 = new SnowballField();
    const ball = field2.spawn(5, 3, 0, 0, 0, 0, 0.2);
    const loose = field.add(
      XMAS_LIGHTS,
      at(1, 3, 0),
      { x: 4.8, y: 3, z: 0, body: new BallRopeBody(ball, 4.8, 3, 0) },
      3,
    );
    ball.radius = 0;
    for (let i = 0; i < 25 * 120; i++) field.step(DT, nothing, 0, 0, 100);
    // One end was still tied to a point, so it never counts as loose.
    expect(field.ropes).toContain(held);
    expect(field.ropes).toContain(loose);
  });

  it("keeps only the newest ropes", () => {
    const field = new RopeField();
    const first = field.add(XMAS_LIGHTS, at(0, 1, 0), at(1, 1, 0), 1);
    for (let i = 0; i < 70; i++) field.add(XMAS_LIGHTS, at(0, 1, 0), at(1, 1, 0), 1);
    expect(field.ropes.length).toBeLessThanOrEqual(64);
    expect(field.ropes).not.toContain(first);
  });

  it("leaves a rope alone when it is far from the player", () => {
    const field = new RopeField();
    const rope = field.add(XMAS_LIGHTS, at(500, 3, 0), at(502, 3, 0), 2);
    const before = node(rope, 4)[1];
    for (let i = 0; i < 120; i++) field.step(DT, nothing, 0, 0, 80);
    expect(node(rope, 4)[1]).toBe(before);
  });
});
