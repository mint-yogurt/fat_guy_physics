import { describe, expect, it } from "vitest";

import type { SolidQuery } from "../sim/collision.ts";
import { VOXEL_SIZE } from "../sim/constants.ts";
import {
  spherePushOut,
  type ElasticBounds,
  type ElasticCollider,
  type ElasticVec,
} from "../sim/elastic.ts";
import { createPlayerInput, Player, PLAYER_MASS } from "../sim/player.ts";
import { PlayerBody } from "../sim/playerBody.ts";
import { planRope, Rope, XMAS_LIGHTS, type RopeTie } from "./rope.ts";

/**
 * A rope as something that is walked into: it stretches round the thing,
 * stops it, and throws it back. Anything elastic does this with any
 * collider, so most of it is tested with a bare ball, not the player.
 */

const DT = 1 / 120;
const floor: SolidQuery = { isSolid: (_vx, vy) => (vy + 0.5) * VOXEL_SIZE < 0 };
const air: SolidQuery = { isSolid: () => false };
const at = (x: number, y: number, z: number): RopeTie => ({ x, y, z });

/** A string 5m long along x at z=0, tied at `height`. */
function string(height: number): Rope {
  return new Rope(1, XMAS_LIGHTS, at(-2.5, height, 0), at(2.5, height, 0), planRope(XMAS_LIGHTS, 5).length);
}

/** The simplest collider there is: a ball in free flight. */
class Ball implements ElasticCollider {
  readonly mass = 20;
  vx = 0;
  vy = 0;
  vz = 0;
  constructor(
    public x: number,
    public y: number,
    public z: number,
    private readonly radius = 0.5,
  ) {}
  bounds(out: ElasticBounds): boolean {
    out.x = this.x;
    out.y = this.y;
    out.z = this.z;
    out.radius = this.radius;
    return true;
  }
  pushOut(x: number, y: number, z: number, r: number, out: ElasticVec): boolean {
    return spherePushOut(this.x, this.y, this.z, this.radius, x, y, z, r, out);
  }
  velocity(out: ElasticVec): void {
    out.x = this.vx;
    out.y = this.vy;
    out.z = this.vz;
  }
  push(ix: number, iy: number, iz: number): void {
    this.vx += ix / this.mass;
    this.vy += iy / this.mass;
    this.vz += iz / this.mass;
  }
}

/** Throws a ball at the middle of the string at `speed`; how it fares. */
function throwBall(speed: number): { deepest: number; tension: number; returned: number } {
  const rope = string(1.2);
  const ball = new Ball(0, 1.2, 3);
  ball.vz = -speed;
  let deepest = 3;
  let tension = 0;
  let returned = 0;
  for (let i = 0; i < 4 / DT; i++) {
    ball.x += ball.vx * DT;
    ball.y += ball.vy * DT;
    ball.z += ball.vz * DT;
    rope.step(DT, air, [ball]);
    deepest = Math.min(deepest, ball.z);
    tension = Math.max(tension, rope.stretchForce);
    returned = Math.max(returned, ball.vz);
  }
  return { deepest, tension, returned };
}

describe("a string with something thrown into it", () => {
  it("stretches round it, holds it, and throws it back", () => {
    const { deepest, returned } = throwBall(6);
    expect(deepest).toBeLessThan(-0.3); // it gave: the ball went past the line the string was tied along
    expect(deepest).toBeGreaterThan(-2.5); // but held
    expect(returned).toBeGreaterThan(3); // and came back at a good part of the speed it went in at
  });

  it("pushes back harder the further it was stretched", () => {
    const slow = throwBall(3);
    const fast = throwBall(9);
    expect(fast.deepest).toBeLessThan(slow.deepest);
    expect(fast.tension).toBeGreaterThan(slow.tension * 2);
    expect(fast.returned).toBeGreaterThan(slow.returned * 2);
  });

  it("does not push on anything it is not touching", () => {
    const rope = string(1.2);
    const ball = new Ball(0, 3, 3);
    for (let i = 0; i < 1 / DT; i++) rope.step(DT, air, [ball]);
    expect(Math.hypot(ball.vx, ball.vy, ball.vz)).toBe(0);
  });
});

describe("a string walked into", () => {
  function walkInto(height: number): { player: Player; deepest: number; peakBack: number } {
    const rope = string(height);
    const player = new Player(0, 0, 3); // facing -z, toward the string
    const body = new PlayerBody(player);
    const input = createPlayerInput();
    input.moveZ = 1;
    let deepest = 3;
    let peakBack = 0;
    let released = false;
    for (let i = 0; i < 5 / DT; i++) {
      player.update(input, DT, floor, () => 0);
      rope.step(DT, floor, [body]);
      deepest = Math.min(deepest, player.z);
      peakBack = Math.max(peakBack, player.vz);
      // Stopped by the string: let go of the key and let it snap back.
      if (!released && player.z < 2 && player.vz > -0.3) {
        released = true;
        input.moveZ = 0;
      }
    }
    return { player, deepest, peakBack };
  }

  it("stretches, stops them, and snaps back faster than they walk", () => {
    const { player, deepest, peakBack } = walkInto(1.2);
    expect(deepest).toBeLessThan(-0.5);
    expect(deepest).toBeGreaterThan(-2.5);
    expect(peakBack).toBeGreaterThan(player.walkSpeed);
    expect(player.z).toBeGreaterThan(0); // thrown back to the side they came from
  });

  it("is a bump to a ragball too", () => {
    const rope = string(0.9);
    const player = new Player(0, 0, 3);
    player.toggleMode(floor);
    const body = new PlayerBody(player);
    const input = createPlayerInput();
    player.vz = -6;
    let deepest = 3;
    for (let i = 0; i < 4 / DT; i++) {
      player.update(input, DT, floor, () => 0);
      rope.step(DT, floor, [body]);
      deepest = Math.min(deepest, player.z);
    }
    expect(deepest).toBeGreaterThan(-3);
    expect(player.vz).toBeGreaterThan(0);
  });

  it("is stepped over when it lies low", () => {
    const { deepest } = walkInto(0.1);
    expect(deepest).toBeLessThan(-5);
  });

  it("gives the player the push as a knock that steering does not undo in a step", () => {
    const player = new Player(0, 0, 0);
    const input = createPlayerInput();
    for (let i = 0; i < 10; i++) player.update(input, DT, floor, () => 0);
    player.applyImpulse(0, 0, PLAYER_MASS * 5); // 5 m/s
    player.update(input, DT, floor, () => 0);
    expect(player.vz).toBeGreaterThan(4.5); // steering alone would have braked it hard
    for (let i = 0; i < 2 / DT; i++) player.update(input, DT, floor, () => 0);
    expect(Math.abs(player.vz)).toBeLessThan(0.05); // and it wears off
  });
});
