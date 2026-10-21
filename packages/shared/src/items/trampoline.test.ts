import { describe, expect, it } from "vitest";

import type { SolidQuery } from "../sim/collision.ts";
import { VOXEL_SIZE } from "../sim/constants.ts";
import { createPlayerInput, GRAVITY, Player, type PlayerInput } from "../sim/player.ts";
import { SceneSolidQuery } from "../sim/sceneQuery.ts";
import {
  bounceSpeed,
  MIN_BOUNCE_IMPACT,
  PUMP_CAP_SPEED,
  STAND_JUMP_SPEED,
  TRAMPOLINE_HEIGHT,
  TRAMPOLINE_RADIUS,
  TrampolineField,
  type BouncePlayer,
} from "./trampoline.ts";

const DT = 1 / 120;

describe("bounceSpeed", () => {
  it("gives almost nothing back for a walk-on", () => {
    expect(bounceSpeed(0.15, false)).toBe(0);
    expect(bounceSpeed(MIN_BOUNCE_IMPACT - 0.01, false)).toBe(0);
  });

  it("returns less than it was given, never more, without pumping", () => {
    for (const impact of [2, 5, 10, 25]) {
      const out = bounceSpeed(impact, false);
      expect(out).toBeGreaterThan(0);
      expect(out).toBeLessThan(impact);
    }
  });

  it("climbs with timed jumps and levels off at the pump cap", () => {
    let speed = STAND_JUMP_SPEED;
    let previous = 0;
    for (let bounce = 0; bounce < 40; bounce++) {
      previous = speed;
      speed = bounceSpeed(speed, true);
    }
    expect(speed).toBeGreaterThan(STAND_JUMP_SPEED * 2);
    expect(speed).toBeLessThanOrEqual(PUMP_CAP_SPEED + 1e-9);
    expect(speed).toBeCloseTo(previous, 5);
  });

  it("does not cap energy that came from a fall", () => {
    expect(bounceSpeed(25, true)).toBeCloseTo(bounceSpeed(25, false), 9);
    expect(bounceSpeed(25, false)).toBeGreaterThan(PUMP_CAP_SPEED);
  });
});

describe("TrampolineField", () => {
  const field = new TrampolineField();
  const mat = field.place(0, 10, 0);

  it("refuses to overlap another mat", () => {
    expect(mat).toBeDefined();
    expect(field.canPlace(TRAMPOLINE_RADIUS, 0)).toBe(false);
    expect(field.place(TRAMPOLINE_RADIUS * 2.1, 10, 0)).toBeDefined();
  });

  const standing = (): BouncePlayer => ({
    x: 0,
    y: 10 + TRAMPOLINE_HEIGHT,
    z: 0,
    vy: 0,
    grounded: true,
  });

  it("bounces a player who lands hard, in proportion to how hard", () => {
    const soft = standing();
    field.afterPlayerStep(soft, false, -4, DT, false, false);
    const hard = standing();
    field.afterPlayerStep(hard, false, -12, DT, false, false);
    expect(soft.vy).toBeGreaterThan(0);
    expect(hard.vy).toBeGreaterThan(soft.vy);
    expect(hard.grounded).toBe(false);
    // Energy out never exceeds energy in.
    expect(hard.vy).toBeLessThan(-(-12 + GRAVITY * DT));
  });

  it("reports the impact speed of a bounce, and 0 for anything else", () => {
    const hard = standing();
    expect(field.afterPlayerStep(hard, false, -12, DT, false, false)).toBeCloseTo(-(-12 + GRAVITY * DT));
    const walker = standing();
    expect(field.afterPlayerStep(walker, false, 0, DT, false, false)).toBe(0);
    const jumper = standing();
    jumper.vy = 6.3;
    jumper.grounded = false;
    expect(field.afterPlayerStep(jumper, true, 0, DT, true, false)).toBe(0);
  });

  it("does not bounce a player walking on", () => {
    const walker = standing();
    field.afterPlayerStep(walker, false, 0, DT, false, false);
    expect(walker.vy).toBe(0);
    expect(walker.grounded).toBe(true);
  });

  it("turns a jump from standing into a small hop", () => {
    expect(field.isStandingOn(standing())).toBe(true);
    const jumper = standing();
    jumper.vy = 6.3;
    jumper.grounded = false;
    field.afterPlayerStep(jumper, true, 0, DT, true, false);
    expect(jumper.vy).toBe(STAND_JUMP_SPEED);
  });

  it("leaves a landing off the mat alone", () => {
    const away = standing();
    away.x = 20;
    field.afterPlayerStep(away, false, -12, DT, false, false);
    expect(away.vy).toBe(0);
  });

  it("reports the mat top and restitution only over the mat", () => {
    expect(field.topAt(0.5, 0)).toBe(10 + TRAMPOLINE_HEIGHT);
    expect(field.topAt(TRAMPOLINE_RADIUS + 0.06, 0)).toBeUndefined();
    expect(field.restitutionAt(0, 0)).toBeGreaterThan(0.5);
    expect(field.restitutionAt(50, 0)).toBe(0);
  });

  it("targets a mat under the aim and not one off it", () => {
    expect(field.target(0, 11.5, -3, 0, -0.3, 1, 5)).toBe(mat);
    expect(field.target(0, 11.5, -3, 0, 0, -1, 5)).toBeUndefined();
  });
});

describe("player on a mat, through the real collision", () => {
  const BASE = 1; // flat ground top at y=1m (voxel 10)
  const flatGround: SolidQuery = { isSolid: (_vx, vy) => vy < BASE / VOXEL_SIZE };

  function setup(): { field: TrampolineField; query: SceneSolidQuery; player: Player } {
    const field = new TrampolineField();
    field.place(0, BASE, 0);
    const query = new SceneSolidQuery(flatGround);
    field.collectNear(0, 0, 3, query.statics);
    return { field, query, player: new Player(0, BASE + 0.5, 0) };
  }

  /** One substep, the way main.ts runs it. */
  function step(
    s: ReturnType<typeof setup>,
    input: PlayerInput,
    pumping: boolean,
  ): void {
    const wasOn = s.field.isStandingOn(s.player);
    const preVy = s.player.vy;
    s.player.update(input, DT, s.query, () => 0);
    s.field.afterPlayerStep(s.player, wasOn, preVy, DT, input.jumpPressed, pumping);
    input.jumpPressed = false;
  }

  /** Peak height above the mat reached by the next bounce after `fall` metres of drop. */
  function peakAfterDrop(fall: number): number {
    const s = setup();
    s.player.y = BASE + TRAMPOLINE_HEIGHT + fall;
    const input = createPlayerInput();
    let landed = false;
    let peak = 0;
    for (let i = 0; i < 2400; i++) {
      step(s, input, false);
      if (!landed && s.player.vy > 0) landed = true;
      if (landed) peak = Math.max(peak, s.player.y - (BASE + TRAMPOLINE_HEIGHT));
      if (landed && s.player.vy < 0) break;
    }
    return peak;
  }

  it("stands on the mat and stays put when dropped from a hair above", () => {
    const s = setup();
    const input = createPlayerInput();
    for (let i = 0; i < 240; i++) step(s, input, false);
    expect(s.player.y).toBeCloseTo(BASE + TRAMPOLINE_HEIGHT, 1);
    expect(s.player.grounded).toBe(true);
  });

  it("walks onto the mat from the side without bouncing", () => {
    const s = setup();
    s.player.x = -3;
    s.player.y = BASE;
    const input = createPlayerInput();
    input.moveZ = 1;
    s.player.look(90 / s.player.mouseSensitivity, 0); // yaw -90 -> 0: face +X
    let maxVy = 0;
    for (let i = 0; i < 90; i++) {
      step(s, input, false);
      maxVy = Math.max(maxVy, s.player.vy);
    }
    expect(s.player.x).toBeGreaterThan(-0.5);
    expect(s.player.y).toBeCloseTo(BASE + TRAMPOLINE_HEIGHT, 1);
    expect(maxVy).toBeLessThan(1);
  });

  it("bounces higher the higher the drop, and never above the drop height", () => {
    const low = peakAfterDrop(1);
    const high = peakAfterDrop(4);
    expect(low).toBeGreaterThan(0.3);
    expect(high).toBeGreaterThan(low * 2);
    expect(high).toBeLessThan(4);
  });

  it("builds a standing hop into higher bounces while jumps are timed", () => {
    const s = setup();
    const input = createPlayerInput();
    for (let i = 0; i < 120; i++) step(s, input, false); // settle
    const peaks: number[] = [];
    let previousVy = 0;
    input.jumpPressed = true;
    for (let i = 0; i < 6000 && peaks.length < 8; i++) {
      step(s, input, true); // space held throughout
      if (previousVy > 0 && s.player.vy <= 0) peaks.push(s.player.y - (BASE + TRAMPOLINE_HEIGHT));
      previousVy = s.player.vy;
    }
    expect(peaks.length).toBeGreaterThanOrEqual(6);
    expect(peaks[2] ?? 0).toBeGreaterThan(peaks[0] ?? 0);
    expect(peaks[peaks.length - 1] ?? 0).toBeGreaterThan(peaks[1] ?? 0);
  });
});
