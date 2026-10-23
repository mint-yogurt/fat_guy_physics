import { describe, expect, it } from "vitest";

import { FIXED_TIMESTEP } from "../sim/constants.ts";
import { GRAVITY } from "../sim/player.ts";
import {
  SPRING_JUMP_FACTOR,
  SPRING_MAT_CAP_SPEED,
  SPRING_PUMP_CAP_SPEED,
  SPRING_RESTITUTION,
  SPRING_SHOES_LIFETIME,
  SpringStride,
  STRIDE_BOOST,
  STRIDE_CAP_SPEED,
  STRIDE_HOP_SPEED,
  type StrideStep,
} from "./springShoes.ts";

const JUMP = 6.3;

function step(over: Partial<StrideStep> = {}): StrideStep {
  return { wasGrounded: true, preVy: 0, moving: false, jumped: false, pumping: false, matRebound: 0, ...over };
}

/** The speed a fall of `height` metres lands at. */
const fallSpeed = (height: number): number => Math.sqrt(2 * -GRAVITY * height);

/** Runs a landing at `impact` m/s and returns the rebound speed. */
function land(stride: SpringStride, impact: number, over: Partial<StrideStep> = {}): number {
  const player = { vy: 0, grounded: true };
  // The player's own step turns preVy into a landing: undo gravity's share of it.
  const preVy = -impact - GRAVITY * FIXED_TIMESTEP;
  stride.afterPlayerStep(player, FIXED_TIMESTEP, step({ wasGrounded: false, preVy, ...over }), JUMP);
  return player.vy;
}

describe("spring shoes", () => {
  it("leap on every step while walking, and do nothing standing still", () => {
    const stride = new SpringStride();
    const walking = { vy: 0, grounded: true };
    expect(stride.afterPlayerStep(walking, FIXED_TIMESTEP, step({ moving: true }), JUMP)).toBe(STRIDE_HOP_SPEED);
    expect(walking.vy).toBe(STRIDE_HOP_SPEED);
    expect(walking.grounded).toBe(false);

    const standing = { vy: 0, grounded: true };
    expect(stride.afterPlayerStep(standing, FIXED_TIMESTEP, step(), JUMP)).toBe(0);
    expect(standing).toEqual({ vy: 0, grounded: true });
  });

  it("leave a player in the air alone", () => {
    const stride = new SpringStride();
    const falling = { vy: -3, grounded: false };
    expect(stride.afterPlayerStep(falling, FIXED_TIMESTEP, step({ wasGrounded: false, preVy: -3, moving: true }), JUMP)).toBe(0);
    expect(falling.vy).toBe(-3);
  });

  it("jump much higher than a plain jump", () => {
    const stride = new SpringStride();
    const player = { vy: JUMP, grounded: false };
    stride.afterPlayerStep(player, FIXED_TIMESTEP, step({ jumped: true }), JUMP);
    expect(player.vy).toBeCloseTo(JUMP * SPRING_JUMP_FACTOR);
  });

  it("give a landing back as a rebound, like a spring", () => {
    const stride = new SpringStride();
    expect(land(stride, 6)).toBeCloseTo(6 * SPRING_RESTITUTION);
    // A footfall is not a rebound: the next step is a leap or nothing.
    expect(land(stride, 1)).toBe(0);
  });

  it("climb with each bounding stride, up to a cap", () => {
    const stride = new SpringStride();
    let speed = STRIDE_HOP_SPEED;
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      speed = land(stride, speed, { moving: true });
      seen.push(speed);
    }
    expect(seen[0]).toBeCloseTo(STRIDE_HOP_SPEED * SPRING_RESTITUTION + STRIDE_BOOST);
    expect(seen[1]).toBeGreaterThan(seen[0] ?? 0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(STRIDE_CAP_SPEED + 1e-9);
    // Settles at the cap, not past it.
    expect(speed).toBeGreaterThan(STRIDE_CAP_SPEED - 1);
  });

  it("die away on the spot with no legs behind them", () => {
    const stride = new SpringStride();
    let speed = 8;
    for (let i = 0; i < 6; i++) speed = land(stride, speed);
    expect(speed).toBeLessThan(8 * 0.6);
  });

  it("pump higher when the landing is timed with a jump, to a higher cap", () => {
    const stride = new SpringStride();
    const plain = land(stride, 8, { moving: true });
    const pumped = land(stride, 8, { moving: true, pumping: true });
    expect(pumped).toBeGreaterThan(plain);
    let speed = 8;
    for (let i = 0; i < 40; i++) speed = land(stride, speed, { moving: true, pumping: true });
    expect(speed).toBeLessThanOrEqual(SPRING_PUMP_CAP_SPEED + 1e-9);
    expect(speed).toBeGreaterThan(STRIDE_CAP_SPEED);
  });

  it("come off a drop from height higher than the legs ever could, past the caps", () => {
    const stride = new SpringStride();
    const drop = fallSpeed(30);
    expect(drop).toBeGreaterThan(SPRING_PUMP_CAP_SPEED);
    expect(land(stride, drop, { moving: true, pumping: true })).toBeCloseTo(drop * SPRING_RESTITUTION);
  });

  it("add to a trampoline's rebound, and stop adding at a cap", () => {
    const stride = new SpringStride();
    const mat = { vy: 8, grounded: false };
    stride.afterPlayerStep(mat, FIXED_TIMESTEP, step({ wasGrounded: false, matRebound: 9 }), JUMP);
    expect(mat.vy).toBeGreaterThan(8);

    const fast = { vy: SPRING_MAT_CAP_SPEED + 5, grounded: false };
    stride.afterPlayerStep(fast, FIXED_TIMESTEP, step({ wasGrounded: false, matRebound: 30 }), JUMP);
    expect(fast.vy).toBeCloseTo(SPRING_MAT_CAP_SPEED + 5);
  });

  it("count their bounds for the wear to come, and do not wear out yet", () => {
    const stride = new SpringStride();
    expect(stride.bounds).toBe(0);
    land(stride, 6);
    land(stride, 6);
    stride.afterPlayerStep({ vy: 0, grounded: true }, FIXED_TIMESTEP, step({ moving: true }), JUMP);
    expect(stride.bounds).toBe(3);
    expect(SPRING_SHOES_LIFETIME).toBe(Number.POSITIVE_INFINITY);
    expect(stride.wornOut).toBe(false);
  });
});
