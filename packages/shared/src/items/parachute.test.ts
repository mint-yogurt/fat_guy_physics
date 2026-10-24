import { describe, expect, it } from "vitest";

import { FIXED_TIMESTEP } from "../sim/constants.ts";
import type { SolidQuery } from "../sim/collision.ts";
import { createPlayerInput, Player, PlayerMode } from "../sim/player.ts";
import { GEAR_SLOT_OF, GearSlot, isWorn } from "./gear.ts";
import { ItemType } from "./inventory.ts";
import {
  CHUTE_OPEN_SECONDS,
  CHUTE_SINK_SPEED,
  CHUTE_SPEED,
  CHUTE_TURN_DEG,
  Glide,
} from "./parachute.ts";

/** Open air over a floor at y = 0. */
const FLOOR: SolidQuery = { isSolid: (_vx, vy) => vy < 0 };

const noSurface = (): number => 0;

/** A player `height` metres up, looking down +X (yaw 0). */
function dropper(height: number, gliding: boolean): Player {
  const player = new Player(0, height, 0);
  player.setLook(0, 0);
  player.gliding = gliding;
  return player;
}

/** Runs the player until they land (or `limit` seconds pass); returns seconds taken. */
function fall(player: Player, input = createPlayerInput(), limit = 120): number {
  let steps = 0;
  while (!player.grounded && steps * FIXED_TIMESTEP < limit) {
    player.update(input, FIXED_TIMESTEP, FLOOR, noSurface);
    steps++;
  }
  return steps * FIXED_TIMESTEP;
}

describe("parachute", () => {
  it("slows the fall to a steady sink and carries the player forward", () => {
    const player = dropper(100, true);
    const input = createPlayerInput();
    for (let i = 0; i < 6 / FIXED_TIMESTEP; i++) player.update(input, FIXED_TIMESTEP, FLOOR, noSurface);
    expect(player.glide.open).toBe(1);
    expect(player.vy).toBeGreaterThan(-CHUTE_SINK_SPEED - 0.1);
    expect(player.vy).toBeLessThan(-CHUTE_SINK_SPEED + 0.1);
    expect(Math.hypot(player.vx, player.vz)).toBeGreaterThan(CHUTE_SPEED - 0.3);
    expect(player.x).toBeGreaterThan(10);
  });

  it("goes farther the higher it is opened", () => {
    const low = dropper(40, true);
    const high = dropper(120, true);
    fall(low);
    fall(high);
    expect(high.x).toBeGreaterThan(low.x * 2);
    // Close to the glide ratio, less the fall before it opened.
    expect(high.x).toBeGreaterThan(((120 - 30) * CHUTE_SPEED) / CHUTE_SINK_SPEED);
  });

  it("does nothing unless it is worn, and falls as before", () => {
    const bare = dropper(100, false);
    const worn = dropper(100, true);
    expect(fall(bare)).toBeLessThan(fall(worn) / 2);
    expect(bare.glide.open).toBe(0);
  });

  it("opens at once when the fall starts, and not while rising", () => {
    const player = dropper(50, true);
    const input = createPlayerInput();
    player.vy = 6;
    player.update(input, FIXED_TIMESTEP, FLOOR, noSurface);
    expect(player.glide.open).toBe(0);
    while (player.vy > -1) player.update(input, FIXED_TIMESTEP, FLOOR, noSurface);
    player.update(input, FIXED_TIMESTEP, FLOOR, noSurface);
    expect(player.glide.open).toBeGreaterThan(0);
    for (let i = 0; i < 0.3 / FIXED_TIMESTEP; i++) player.update(input, FIXED_TIMESTEP, FLOOR, noSurface);
    expect(player.glide.open).toBe(1);
    expect(player.vy).toBeGreaterThan(-CHUTE_SINK_SPEED - 0.2);
  });

  it("fills over its opening time, not at once", () => {
    const player = dropper(200, true);
    const input = createPlayerInput();
    // Fall until it lets go, then watch it fill.
    while (player.glide.open === 0) player.update(input, FIXED_TIMESTEP, FLOOR, noSurface);
    expect(player.glide.open).toBeGreaterThan(0);
    expect(player.glide.open).toBeLessThan(0.1);
    for (let i = 0; i < (CHUTE_OPEN_SECONDS * 1.1) / FIXED_TIMESTEP; i++) {
      player.update(input, FIXED_TIMESTEP, FLOOR, noSurface);
    }
    expect(player.glide.open).toBe(1);
  });

  it("closes on landing and when put away", () => {
    const player = dropper(60, true);
    fall(player);
    expect(player.grounded).toBe(true);
    player.update(createPlayerInput(), FIXED_TIMESTEP, FLOOR, noSurface);
    expect(player.glide.open).toBe(0);

    const mid = dropper(100, true);
    for (let i = 0; i < 3 / FIXED_TIMESTEP; i++) mid.update(createPlayerInput(), FIXED_TIMESTEP, FLOOR, noSurface);
    expect(mid.glide.open).toBe(1);
    mid.gliding = false;
    mid.update(createPlayerInput(), FIXED_TIMESTEP, FLOOR, noSurface);
    expect(mid.glide.open).toBe(0);
  });

  it("is not used by a ragball", () => {
    const player = dropper(100, true);
    player.mode = PlayerMode.Ragball;
    for (let i = 0; i < 3 / FIXED_TIMESTEP; i++) player.update(createPlayerInput(), FIXED_TIMESTEP, FLOOR, noSurface);
    expect(player.glide.open).toBe(0);
  });

  it("turns slowly towards where the player looks", () => {
    const player = dropper(300, true);
    const input = createPlayerInput();
    for (let i = 0; i < 2 / FIXED_TIMESTEP; i++) player.update(input, FIXED_TIMESTEP, FLOOR, noSurface);
    expect(player.glide.heading).toBeCloseTo(0, 0);
    player.setLook(180, 0);
    for (let i = 0; i < 1 / FIXED_TIMESTEP; i++) player.update(input, FIXED_TIMESTEP, FLOOR, noSurface);
    // A second of steering moves the heading by the turn rate and no more.
    expect(Math.abs(player.glide.heading)).toBeLessThan(CHUTE_TURN_DEG + 1);
    expect(Math.abs(player.glide.heading)).toBeGreaterThan(CHUTE_TURN_DEG - 1);
  });

  it("turns the short way round the circle", () => {
    const glide = new Glide();
    const player = { vx: 3, vy: -10, vz: 0, grounded: false, yaw: 350 };
    glide.update(player, { moveX: 0, moveZ: 0 }, FIXED_TIMESTEP, true);
    glide.heading = 10;
    glide.update(player, { moveX: 0, moveZ: 0 }, 0.1, true);
    expect(glide.heading).toBeLessThan(10);
  });

  it("lets the keys trim speed and slide, a little", () => {
    const glide = new Glide();
    const player = { vx: 5, vy: -10, vz: 0, grounded: false, yaw: 0 };
    glide.update(player, { moveX: 0, moveZ: 0 }, FIXED_TIMESTEP, true);
    const plain = glide.wishX;
    glide.update(player, { moveX: 0, moveZ: 1 }, FIXED_TIMESTEP, true);
    expect(glide.wishX).toBeGreaterThan(plain);
    expect(glide.wishX).toBeLessThan(plain * 1.5);
    glide.update(player, { moveX: 1, moveZ: 0 }, FIXED_TIMESTEP, true);
    // Heading +X: right is +Z.
    expect(glide.wishZ).toBeGreaterThan(0);
    expect(glide.wishZ).toBeLessThan(2);
  });
});

describe("gear", () => {
  it("is worn while selected, until the item is given a gear slot", () => {
    expect(GEAR_SLOT_OF[ItemType.Parachute]).toBeUndefined();
    expect(isWorn(ItemType.Parachute, ItemType.Parachute)).toBe(true);
    expect(isWorn(ItemType.Parachute, ItemType.Stick)).toBe(false);
    expect(isWorn(ItemType.Parachute, undefined)).toBe(false);
  });

  it("is worn from the gear bar instead once the item has a slot", () => {
    const slots = GEAR_SLOT_OF as Record<number, number>;
    slots[ItemType.Parachute] = GearSlot.Back;
    try {
      expect(isWorn(ItemType.Parachute, ItemType.Parachute)).toBe(false);
      expect(isWorn(ItemType.Parachute, ItemType.Stick, [ItemType.Parachute])).toBe(true);
    } finally {
      delete slots[ItemType.Parachute];
    }
  });
});
