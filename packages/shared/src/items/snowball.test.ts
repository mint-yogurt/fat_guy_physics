import { describe, expect, it } from "vitest";

import type { SolidQuery } from "../sim/collision.ts";
import { VOXEL_SIZE } from "../sim/constants.ts";
import {
  createSnowballHit,
  SNOW_UNIT_RADIUS,
  SNOW_WORTH_RADIUS,
  SNOWBALL_DESPAWN_SECONDS,
  SNOWBALL_MAX_RADIUS,
  SnowballField,
  ThrownSnowballs,
  TrunkQuery,
} from "./snowball.ts";

const DT = 1 / 120;

/** Solid below `height(x, z)` metres. */
const terrain =
  (height: (x: number, z: number) => number): SolidQuery => ({
    isSolid: (vx, vy, vz) =>
      (vy + 0.5) * VOXEL_SIZE < height((vx + 0.5) * VOXEL_SIZE, (vz + 0.5) * VOXEL_SIZE),
  });

const flat = terrain(() => 1);
const snowy = (): boolean => true;
const bare = (): boolean => false;

function roll(
  field: SnowballField,
  query: SolidQuery,
  snowAt: () => boolean,
  seconds: number,
): void {
  for (let i = 0; i < seconds / DT; i++) field.step(DT, query, snowAt);
}

describe("rolled snowball", () => {
  it("grows as it rolls over snow, and not over bare ground", () => {
    for (const [snowAt, grows] of [
      [snowy, true],
      [bare, false],
    ] as const) {
      const field = new SnowballField();
      const ball = field.spawn(0, 1 + SNOW_UNIT_RADIUS, 0, 8, 0, 0);
      roll(field, flat, snowAt, 2);
      expect(ball.x).toBeGreaterThan(5);
      expect(ball.radius > SNOW_UNIT_RADIUS * 1.5).toBe(grows);
      // Sits on the ground, however big it has got.
      expect(ball.y - ball.radius).toBeCloseTo(1, 1);
    }
  });

  it("barely grows from a tap, and stops where it is", () => {
    const field = new SnowballField();
    const ball = field.spawn(0, 1 + SNOW_UNIT_RADIUS, 0, 0.6, 0, 0);
    roll(field, flat, snowy, 4);
    expect(ball.rolling).toBe(false);
    expect(ball.x).toBeLessThan(0.6);
    expect(ball.units).toBe(1);
  });

  it("gains speed and size quickly down a hill, up to a limit", () => {
    const hill = terrain((x) => 12 - x * 0.2);
    const field = new SnowballField();
    const ball = field.spawn(1, 12 - 0.2 + SNOW_UNIT_RADIUS, 0, 1, 0, 0);
    roll(field, hill, snowy, 3);
    expect(Math.hypot(ball.vx, ball.vz)).toBeGreaterThan(4);
    roll(field, hill, snowy, 12);
    expect(ball.radius).toBeGreaterThan(1);
    expect(ball.radius).toBeLessThanOrEqual(SNOWBALL_MAX_RADIUS);
    expect(ball.units).toBeGreaterThan(7);
  });

  it("turns back from a wall rather than through it", () => {
    const wall = terrain((x) => (x > 6 ? 10 : 1));
    const field = new SnowballField();
    const ball = field.spawn(0, 1 + SNOW_UNIT_RADIUS, 0, 9, 0, 0);
    roll(field, wall, snowy, 4);
    expect(ball.x).toBeLessThan(6.01);
    expect(ball.rolling).toBe(false);
  });

  it("gives up snow in proportion and shrinks, then is gone", () => {
    const field = new SnowballField();
    const ball = field.spawn(0, 2, 0, 0, 0, 0, SNOW_WORTH_RADIUS * 6);
    roll(field, flat, bare, 3);
    expect(ball.rolling).toBe(false);
    expect(ball.units).toBe(6);
    const before = ball.radius;
    const bottom = ball.y - ball.radius;

    const first = ball.harvest();
    expect(first).toBeGreaterThanOrEqual(1);
    expect(ball.units).toBe(6 - first);
    expect(ball.radius).toBeCloseTo((before * (6 - first)) / 6, 6);
    // Shrinks onto the ground it was lying on.
    expect(ball.y - ball.radius).toBeCloseTo(bottom, 6);

    let total = first;
    for (let i = 0; i < 20 && !ball.spent; i++) total += ball.harvest();
    expect(total).toBe(6);
    expect(ball.spent).toBe(true);
    field.tick(DT, 0, 0, 1000);
    expect(field.balls.length).toBe(0);
  });

  it("is worth more snow the bigger it is: twice the size, twice the units", () => {
    const field = new SnowballField();
    const small = field.spawn(0, 5, 0, 0, 0, 0, SNOW_UNIT_RADIUS);
    const double = field.spawn(0, 5, 0, 0, 0, 0, SNOW_WORTH_RADIUS * 2);
    const between = field.spawn(0, 5, 0, 0, 0, 0, SNOW_WORTH_RADIUS * 1.5);
    const nudge = field.spawn(0, 5, 0, 0, 0, 0, SNOW_WORTH_RADIUS * 1.15);
    expect([small.units, double.units, between.units, nudge.units]).toEqual([1, 2, 2, 1]);
  });

  it("is forgotten after five minutes with the player out of range, not before", () => {
    const field = new SnowballField();
    const ball = field.spawn(100, 1.2, 0, 0, 0, 0);
    field.tick(1, 0, 0, 50);
    expect(ball.far).toBe(true);
    // Frozen out of range: does not roll.
    ball.vx = 5;
    field.step(DT, flat, snowy);
    expect(ball.x).toBe(100);

    for (let t = 1; t < SNOWBALL_DESPAWN_SECONDS - 1; t++) field.tick(1, 0, 0, 50);
    expect(field.balls.length).toBe(1);
    // Coming back resets the clock.
    field.tick(1, 99, 0, 50);
    expect(ball.away).toBe(0);
    for (let t = 0; t < SNOWBALL_DESPAWN_SECONDS - 1; t++) field.tick(1, 0, 0, 50);
    expect(field.balls.length).toBe(1);
    field.tick(2, 0, 0, 50);
    expect(field.balls.length).toBe(0);
  });

  it("can be picked out by a ray, and only when it is in front", () => {
    const field = new SnowballField();
    const ball = field.spawn(5, 2, 0, 0, 0, 0, 0.5);
    const hit = createSnowballHit();
    expect(field.raycast(0, 2, 0, 1, 0, 0, 10, hit).ball).toBe(ball);
    expect(hit.distance).toBeCloseTo(4.5, 5);
    expect(field.raycast(0, 2, 0, 1, 0, 0, 3, hit).ball).toBeUndefined();
    expect(field.raycast(0, 2, 0, -1, 0, 0, 10, hit).ball).toBeUndefined();
    expect(field.raycast(0, 3.2, 0, 1, 0, 0, 10, hit).ball).toBeUndefined();
  });

  it("is shoved rolling by a walker, and grows as they push it on snow", () => {
    const field = new SnowballField();
    const ball = field.spawn(2, 1 + 0.4, 0, 0, 0, 0, 0.4);
    roll(field, flat, snowy, 1);
    expect(ball.rolling).toBe(false);
    const before = ball.radius;

    // Walks along +x at 3 m/s from 2m back, feet on the ground, for four seconds.
    let walker = 0;
    for (let i = 0; i < 4 / DT; i++) {
      walker += 3 * DT;
      field.pushedBy(walker, 1, 0, 3, 0, 0.55, 1.9);
      field.step(DT, flat, snowy);
    }
    expect(ball.rolling).toBe(true);
    expect(ball.x).toBeGreaterThan(8);
    expect(ball.radius).toBeGreaterThan(before * 1.3);
    // It stays ahead of them rather than being walked through.
    expect(ball.x - walker).toBeGreaterThan(0.9);
  });

  it("is not walked through when it cannot move: the walker is held back", () => {
    const wall = terrain((x) => (x > 6 ? 10 : 1));
    const field = new SnowballField();
    const ball = field.spawn(5, 1.4, 0, 0, 0, 0, 0.4);
    roll(field, wall, snowy, 1);
    let walker = 3;
    const back = { x: 0, z: 0 };
    for (let i = 0; i < 1.2 / DT; i++) {
      walker += 3 * DT;
      field.pushedBy(walker, 1, 0, 3, 0, 0.55, 1.9);
      field.step(DT, wall, snowy);
      field.yieldTo(walker, 1, 0, 0.55, 1.9, back);
      walker += back.x;
    }
    expect(ball.x).toBeLessThan(6.01);
    expect(walker).toBeLessThan(ball.x - 0.9);
  });

  it("is only shoved by someone at its height, and not by one walking away", () => {
    const field = new SnowballField();
    const ball = field.spawn(2, 1.2, 0, 0, 0, 0, 0.2);
    roll(field, flat, snowy, 1);
    // Jumping clear above it, then walking off from it.
    field.pushedBy(2, 2.5, 0, 3, 0, 0.55, 1.9);
    expect(ball.rolling).toBe(false);
    field.pushedBy(2.5, 1, 0, 3, 0, 0.55, 1.9);
    expect(ball.vx).toBe(0);
  });
});

describe("snowballs among themselves", () => {
  it("a rolling ball stops against a settled one instead of passing through", () => {
    const field = new SnowballField();
    const still = field.spawn(4, 1.5, 0, 0, 0, 0, 0.5);
    roll(field, flat, bare, 1.5);
    expect(still.rolling).toBe(false);
    const mover = field.spawn(0, 1 + 0.3, 0, 5, 0, 0, 0.3);
    roll(field, flat, bare, 3);
    expect(mover.x).toBeLessThan(still.x - 0.79);
    expect(still.x).toBe(4);
  });

  it("two rolling balls push each other, the bigger the less", () => {
    const field = new SnowballField();
    const small = field.spawn(0, 1.2, 0, 4, 0, 0, 0.2);
    const big = field.spawn(3, 1.8, 0, 0, 0, 0, 0.8);
    roll(field, flat, bare, 2);
    expect(small.x).toBeLessThan(big.x - 0.99);
    expect(big.vx).toBeGreaterThanOrEqual(0);
    expect(small.vx).toBeLessThan(1);
  });
});

describe("thrown snowball", () => {
  it("flies fairly flat and bursts on a wall, facing back the way it came", () => {
    const wall = terrain((x) => (x > 12 ? 10 : 1));
    const thrown = new ThrownSnowballs();
    thrown.throw(0, 2.5, 0, 22, 1, 0);
    for (let i = 0; i < 2 / DT && thrown.flying.length > 0; i++) thrown.step(DT, wall);
    expect(thrown.flying.length).toBe(0);
    expect(thrown.bursts.length).toBe(1);
    const burst = thrown.bursts[0];
    expect(burst?.x).toBeGreaterThan(11.5);
    expect(burst?.x).toBeLessThan(12.2);
    expect(burst?.nx).toBeLessThan(-0.9);
    // Dropped less than a metre or so over the throw.
    expect(burst?.y).toBeGreaterThan(1.5);
  });

  it("bursts on the ground too, and on a trunk in its way", () => {
    const thrown = new ThrownSnowballs();
    thrown.throw(0, 1.5, 0, 6, 0, 0);
    for (let i = 0; i < 2 / DT; i++) thrown.step(DT, flat);
    expect(thrown.bursts.length).toBe(1);
    expect(thrown.bursts[0]?.y).toBeLessThan(1.3);

    const trees = new TrunkQuery(flat);
    trees.trunks.push({ x: 5, z: 0, y0: 1, y1: 6, radius: 0.3 });
    const second = new ThrownSnowballs();
    second.throw(0, 2.5, 0, 25, 2, 0);
    for (let i = 0; i < 1 / DT; i++) second.step(DT, trees);
    expect(second.bursts.length).toBe(1);
    expect(second.bursts[0]?.x).toBeLessThan(5);
  });
});
