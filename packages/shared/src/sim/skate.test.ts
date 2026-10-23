import { describe, expect, it } from "vitest";

import type { SolidQuery } from "./collision.ts";
import { VOXEL_SIZE } from "./constants.ts";
import { LooseBoard } from "./looseBoard.ts";
import { createPlayerInput, Player, type PlayerInput } from "./player.ts";

const DT = 1 / 120;

/** Solid below `height(x, z)` metres. */
const terrain =
  (height: (x: number, z: number) => number): SolidQuery => ({
    isSolid: (vx, vy, vz) =>
      (vy + 0.5) * VOXEL_SIZE < height((vx + 0.5) * VOXEL_SIZE, (vz + 0.5) * VOXEL_SIZE),
  });

const flat = terrain(() => 1);

function rider(query: SolidQuery, yawDegrees = 0): { p: Player; input: PlayerInput } {
  const p = new Player(0, 1, 0);
  p.look((yawDegrees + 90) / p.mouseSensitivity, 0);
  p.skating = true;
  const input = createPlayerInput();
  for (let i = 0; i < 60; i++) p.update(input, DT, query, () => 10);
  return { p, input };
}

function run(p: Player, input: PlayerInput, seconds: number, query: SolidQuery): void {
  for (let i = 0; i < seconds / DT; i++) {
    p.update(input, DT, query, () => 10);
    input.jumpPressed = false;
    input.skateTrickPressed = false;
  }
}

describe("skateboard", () => {
  it("pushes slowly at first and ramps up the longer w is held", () => {
    const { p, input } = rider(flat);
    input.moveZ = 1;
    run(p, input, 1, flat);
    const early = Math.hypot(p.vx, p.vz);
    run(p, input, 5, flat);
    const late = Math.hypot(p.vx, p.vz);
    expect(early).toBeGreaterThan(0.5);
    expect(early).toBeLessThan(5);
    expect(late).toBeGreaterThan(early + 2);
    expect(late).toBeLessThan(13);
  });

  it("coasts when w is released, and brakes with s", () => {
    const { p, input } = rider(flat);
    input.moveZ = 1;
    run(p, input, 4, flat);
    input.moveZ = 0;
    const before = Math.hypot(p.vx, p.vz);
    run(p, input, 1, flat);
    const coasted = Math.hypot(p.vx, p.vz);
    expect(coasted).toBeGreaterThan(before * 0.7);
    input.moveZ = -1;
    run(p, input, 1, flat);
    expect(Math.hypot(p.vx, p.vz)).toBeLessThan(coasted * 0.5);
  });

  it("stops pushing at the top speed pushing gives, holds it, and pushes again once under it", () => {
    const { p, input } = rider(flat);
    input.moveZ = 1;
    let pushedAt = 0;
    let stoppedAt = -1;
    for (let i = 0; i < 12 / DT; i++) {
      p.update(input, DT, flat, () => 10);
      if (p.skate.pushing) pushedAt = i * DT;
      else if (stoppedAt < 0 && Math.hypot(p.vx, p.vz) > 4) stoppedAt = i * DT;
    }
    // Long after the run has ramped up: at speed, not pushing, and not slowing.
    expect(p.skate.pushing).toBe(false);
    expect(stoppedAt).toBeGreaterThan(0);
    expect(pushedAt).toBeLessThan(12 - 2);
    const held = Math.hypot(p.vx, p.vz);
    expect(held).toBeGreaterThan(9.5);
    run(p, input, 2, flat);
    expect(Math.hypot(p.vx, p.vz)).toBeGreaterThanOrEqual(held - 0.05);
    expect(p.skate.pushing).toBe(false);

    // Something takes the speed off it (here, a hard shove back): pushing again.
    p.vx *= 0.4;
    p.vz *= 0.4;
    run(p, input, 0.3, flat);
    expect(p.skate.pushing).toBe(true);
  });

  it("leans with the ground: nose up on a rise, down on a fall, banked across a slope, level in the air", () => {
    // Faces +X. A 30% rise, and a 30% fall.
    for (const [rise, sign] of [
      [0.3, 1],
      [-0.3, -1],
    ] as const) {
      const hill = terrain((x) => 4 + x * rise);
      const { p, input } = rider(hill);
      p.x = 0.5;
      p.y = 4 + 0.5 * rise;
      run(p, input, 0.5, hill);
      expect(p.skate.pitch * sign).toBeGreaterThan(0.2);
      expect(Math.abs(p.skate.pitch)).toBeLessThan(0.4);
      expect(Math.abs(p.skate.roll)).toBeLessThan(0.05);
    }
    // Ground that falls away to the board's right/left leans the deck across it.
    const bank = terrain((_, z) => 4 + z * 0.3);
    const banked = rider(bank);
    banked.p.y = 4;
    run(banked.p, banked.input, 0.5, bank);
    expect(Math.abs(banked.p.skate.roll)).toBeGreaterThan(0.2);
    expect(Math.abs(banked.p.skate.pitch)).toBeLessThan(0.05);
    // Off the lip: it levels out.
    const lip = terrain((x) => (x < 3 ? 4 + Math.max(0, x) * 0.3 : -10));
    const jumper = rider(lip);
    jumper.p.x = -1;
    jumper.p.y = 4;
    jumper.p.vx = 9;
    let early = 0;
    for (let i = 0; i < 1.2 / DT; i++) {
      jumper.p.update(jumper.input, DT, lip, () => 10);
      if (jumper.p.grounded && jumper.p.x > 1.5) early = Math.abs(jumper.p.skate.pitch);
      if (!jumper.p.grounded && jumper.p.x > 2.5) break;
    }
    expect(jumper.p.grounded).toBe(false);
    expect(early).toBeGreaterThan(0.2);
    run(jumper.p, jumper.input, 0.5, lip);
    expect(Math.abs(jumper.p.skate.pitch)).toBeLessThan(early * 0.3);
  });

  it("ollies, and lands rolling", () => {
    const { p, input } = rider(flat);
    input.moveZ = 1;
    run(p, input, 3, flat);
    input.jumpPressed = true;
    p.update(input, DT, flat, () => 10);
    input.jumpPressed = false;
    expect(p.vy).toBeGreaterThan(4);
    expect(p.skate.ollies).toBe(1);
    run(p, input, 1.2, flat);
    expect(p.grounded).toBe(true);
    expect(p.skate.isDown).toBe(false);
    expect(Math.hypot(p.vx, p.vz)).toBeGreaterThan(1);
  });

  it("lands a kickflip started early, bails on one started too late", () => {
    for (const [delay, bails] of [
      [0.05, false],
      [0.45, true],
    ] as const) {
      const { p, input } = rider(flat);
      input.moveZ = 1;
      run(p, input, 3, flat);
      input.jumpPressed = true;
      p.update(input, DT, flat, () => 10);
      input.jumpPressed = false;
      run(p, input, delay, flat);
      input.skateTrickPressed = true;
      run(p, input, 1.3, flat);
      expect(p.skate.flips).toBe(1);
      expect(p.skate.bails > 0).toBe(bails);
      expect(p.skate.flipsLanded).toBe(bails ? 0 : 1);
    }
  });

  it("counts a push stroke at the start of a run and again every stroke", () => {
    const { p, input } = rider(flat);
    expect(p.skate.pushes).toBe(0);
    input.moveZ = 1;
    run(p, input, 0.05, flat);
    expect(p.skate.pushes).toBe(1);
    run(p, input, 3, flat);
    // Strokes get quicker as the push ramps up, a few a second.
    expect(p.skate.pushes).toBeGreaterThan(4);
    expect(p.skate.pushes).toBeLessThan(15);
    input.moveZ = 0;
    run(p, input, 0.2, flat);
    const stopped = p.skate.pushes;
    run(p, input, 2, flat);
    expect(p.skate.pushes).toBe(stopped);
  });

  it("bails landing sideways and stops dead", () => {
    const { p, input } = rider(flat);
    input.moveZ = 1;
    run(p, input, 4, flat);
    input.jumpPressed = true;
    p.update(input, DT, flat, () => 10);
    input.jumpPressed = false;
    // Spin the look (and so the board) a quarter turn in the air.
    p.look(90 / p.mouseSensitivity, 0);
    run(p, input, 0.9, flat);
    expect(p.skate.bails).toBe(1);
    expect(Math.hypot(p.vx, p.vz)).toBe(0);
    run(p, input, 1.5, flat);
    expect(p.skate.isDown).toBe(false);
  });

  it("gains speed rolling downhill and leaves the lip of a ramp upward", () => {
    // Faces +X; slopes down 20% over x in [0, 10], then drops away at the end.
    const slope = terrain((x) => (x < 12 ? 4 - Math.max(0, x) * 0.2 : -10));
    const { p, input } = rider(slope);
    p.x = 0.5;
    p.y = 4;
    run(p, input, 0.2, slope);
    const start = Math.hypot(p.vx, p.vz);
    run(p, input, 1, slope);
    expect(Math.hypot(p.vx, p.vz)).toBeGreaterThan(start + 2);

    // Uphill into a lip: speed in, height out.
    const ramp = terrain((x) => (x < 6 ? 1 + Math.max(0, x) * 0.3 : -10));
    const up = rider(ramp);
    up.p.x = -1;
    up.p.y = 1;
    up.p.vx = 12;
    let apex = up.p.y;
    for (let i = 0; i < 2 / DT; i++) {
      up.p.update(up.input, DT, ramp, () => 10);
      apex = Math.max(apex, up.p.y);
      if (up.p.y < -4) break;
    }
    // The ramp top is 2.8m up; without a launch the board would just fall off the lip.
    expect(apex).toBeGreaterThan(2.85);
  });

  it("sends the board on with its speed when the rider bails, until it rests", () => {
    const { p, input } = rider(flat);
    input.moveZ = 1;
    run(p, input, 4, flat);
    const speed = Math.hypot(p.vx, p.vz);
    input.jumpPressed = true;
    p.update(input, DT, flat, () => 10);
    input.jumpPressed = false;
    p.look(90 / p.mouseSensitivity, 0);
    run(p, input, 0.9, flat);
    expect(Math.hypot(p.vx, p.vz)).toBe(0);

    const launch = p.skate.ejected;
    expect(launch).toBeDefined();
    if (launch === undefined) return;
    expect(Math.hypot(launch.vx, launch.vz)).toBeGreaterThan(speed * 0.7);

    const board = new LooseBoard(launch);
    let steps = 0;
    while (!board.settled && steps++ < 30 / DT) board.update(DT, flat);
    expect(board.resting).toBe(true);
    expect(board.y).toBeCloseTo(1, 1);
    // It rolled well clear of where the rider went down.
    expect(Math.hypot(board.x - p.x, board.z - p.z)).toBeGreaterThan(5);
  });

  it("a loose board kicks back off a wall and rolls down a slope", () => {
    const wall = terrain((x) => (x > 5 ? 10 : 1));
    const board = new LooseBoard({
      x: 0, y: 1, z: 0, vx: 9, vy: 0, vz: 0, heading: 0, flip: 0, spin: 0, tumble: 0,
    });
    let furthest = 0;
    for (let i = 0; i < 3 / DT; i++) {
      board.update(DT, wall);
      furthest = Math.max(furthest, board.x);
    }
    expect(furthest).toBeLessThan(5.01);
    expect(board.vx).toBeLessThan(0.5);

    const hill = terrain((x) => 6 - x * 0.2);
    const parked = new LooseBoard({
      x: 2, y: 5.6, z: 0, vx: 0, vy: 0, vz: 0, heading: 0, flip: 0, spin: 0, tumble: 0,
    });
    for (let i = 0; i < 2 / DT; i++) parked.update(DT, hill);
    expect(parked.x).toBeGreaterThan(3);
  });
});
