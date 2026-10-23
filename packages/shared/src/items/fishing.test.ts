import { describe, expect, it } from "vitest";

import {
  castPath,
  createFishingFrame,
  Fishing,
  FISHING,
  FishingState,
  planCast,
  type FishingFrame,
  type FishingInput,
  type FishingSettings,
} from "./fishing.ts";
import { Inventory, ItemType } from "./inventory.ts";
import { PickupField } from "./pickupField.ts";
import { ropeMaxReach, ropeSpecFor, XMAS_LIGHTS } from "./rope.ts";

const flat = (): number => 0;
const DT = 1 / 60;

function countOf(inventory: Inventory, type: ItemType): number {
  let total = 0;
  for (let i = 0; i < inventory.size; i++) {
    const stack = inventory.slot(i);
    if (stack?.type === type) total += stack.count;
  }
  return total;
}

/** A player at the origin looking along +X, a little up, with the rod tip 1.6m up. */
function frameFacingX(): FishingFrame {
  const frame = createFishingFrame();
  frame.tipY = 1.6;
  frame.frontX = Math.cos(0.2);
  frame.frontY = Math.sin(0.2);
  frame.frontZ = 0;
  return frame;
}

const idle: FishingInput = { active: true, cast: false, reel: false };
const charging: FishingInput = { active: true, cast: true, reel: false };
const reeling: FishingInput = { active: true, cast: false, reel: true };

function run(
  rod: Fishing,
  seconds: number,
  input: FishingInput,
  frame: FishingFrame,
  pickups: PickupField,
  inventory: Inventory,
): void {
  for (let t = 0; t < seconds; t += DT) rod.update(DT, input, frame, flat, pickups, inventory);
}

/** Casts after charging for `seconds`, and flies until the hook lands. */
function castAfter(rod: Fishing, seconds: number, frame: FishingFrame, pickups: PickupField, inventory: Inventory): void {
  run(rod, DT, idle, frame, pickups, inventory);
  run(rod, seconds, charging, frame, pickups, inventory);
  run(rod, DT, idle, frame, pickups, inventory);
  run(rod, 4, idle, frame, pickups, inventory);
}

describe("fishing settings", () => {
  it("the line is as long as three strings of xmas lights at full reach", () => {
    expect(FISHING.maxLineLength).toBeCloseTo(ropeMaxReach(ropeSpecFor(XMAS_LIGHTS, 3)), 6);
    expect(FISHING.maxLineLength).toBeCloseTo(15, 6);
  });
});

describe("casting", () => {
  it("lands a full charge near the line's limit, and never past it", () => {
    const rod = new Fishing();
    const frame = frameFacingX();
    castAfter(rod, 2, frame, new PickupField(), new Inventory());
    expect(rod.state).toBe(FishingState.Resting);
    const distance = Math.hypot(rod.hookX - frame.tipX, rod.hookY - frame.tipY, rod.hookZ - frame.tipZ);
    expect(distance).toBeLessThanOrEqual(FISHING.maxLineLength);
    expect(distance).toBeGreaterThan(FISHING.maxLineLength * 0.85);
  });

  it("goes farther the longer the button is held", () => {
    const landing = (seconds: number): number => {
      const rod = new Fishing();
      castAfter(rod, seconds, frameFacingX(), new PickupField(), new Inventory());
      return rod.hookX;
    };
    const tap = landing(0.05);
    const half = landing(FISHING.chargeSeconds / 2);
    const full = landing(FISHING.chargeSeconds + 0.5);
    expect(tap).toBeGreaterThan(0.5);
    expect(half).toBeGreaterThan(tap + 1);
    expect(full).toBeGreaterThan(half + 1);
  });

  it("arcs higher the longer the button is held", () => {
    const frame = frameFacingX();
    const apex = (charge: number): number => {
      const v = { vx: 0, vy: 0, vz: 0 };
      planCast(FISHING, charge, frame.tipY, frame.frontX, frame.frontY, frame.frontZ, v);
      const out = new Float32Array(400 * 3);
      const n = castPath(FISHING, 0, frame.tipY, 0, v, flat, out);
      let top = 0;
      for (let i = 0; i < n; i++) top = Math.max(top, out[i * 3 + 1] ?? 0);
      return top;
    };
    expect(apex(1)).toBeGreaterThan(apex(0.3));
  });

  it("scales with the max line length setting", () => {
    const short: FishingSettings = { ...FISHING, maxLineLength: 6 };
    const rod = new Fishing(short);
    castAfter(rod, 2, frameFacingX(), new PickupField(), new Inventory());
    expect(rod.hookX).toBeGreaterThan(3);
    expect(rod.hookX).toBeLessThanOrEqual(6);
  });

  it("shows an aim line only while charging, and it ends where the cast lands", () => {
    const rod = new Fishing();
    const frame = frameFacingX();
    const pickups = new PickupField();
    const inventory = new Inventory();
    run(rod, DT, idle, frame, pickups, inventory);
    expect(rod.pathCount).toBe(0);
    run(rod, 0.6, charging, frame, pickups, inventory);
    expect(rod.pathCount).toBeGreaterThan(3);
    const last = rod.pathCount - 1;
    const aimedX = rod.path[last * 3] ?? 0;
    const charge = rod.charge;
    run(rod, DT, idle, frame, pickups, inventory);
    expect(rod.charge).toBe(0);
    expect(charge).toBeGreaterThan(0);
    run(rod, 4, idle, frame, pickups, inventory);
    // The preview was for the charge a frame earlier: close to where it came down.
    expect(Math.abs(rod.hookX - aimedX)).toBeLessThan(0.6);
  });

  it("does not cast when the button was already down as the rod came out", () => {
    const rod = new Fishing();
    const frame = frameFacingX();
    const pickups = new PickupField();
    const inventory = new Inventory();
    run(rod, 1, charging, frame, pickups, inventory);
    run(rod, DT, idle, frame, pickups, inventory);
    expect(rod.state).toBe(FishingState.Stowed);
  });

  it("right mouse cancels a charge", () => {
    const rod = new Fishing();
    const frame = frameFacingX();
    const pickups = new PickupField();
    const inventory = new Inventory();
    run(rod, DT, idle, frame, pickups, inventory);
    run(rod, 0.5, charging, frame, pickups, inventory);
    expect(rod.charge).toBeGreaterThan(0);
    run(rod, DT, { active: true, cast: true, reel: true }, frame, pickups, inventory);
    run(rod, DT, idle, frame, pickups, inventory);
    expect(rod.state).toBe(FishingState.Stowed);
  });
});

describe("reeling", () => {
  it("snags a pickup the hook lands on and brings it into the inventory", () => {
    const frame = frameFacingX();
    const probe = new Fishing();
    castAfter(probe, 0.55, frame, new PickupField(), new Inventory());
    const landedX = probe.hookX;

    const pickups = new PickupField();
    pickups.spawn(ItemType.Stick, landedX, 0.3, 0, 0, 0);
    const item = pickups.items[0];
    if (item !== undefined) item.landed = true;
    const inventory = new Inventory();
    const rod = new Fishing();
    castAfter(rod, 0.55, frame, pickups, inventory);
    expect(rod.hooked).toBe(item);

    run(rod, 6, reeling, frame, pickups, inventory);
    expect(rod.state).toBe(FishingState.Stowed);
    expect(rod.hooked).toBeUndefined();
    expect(pickups.items).toHaveLength(0);
    expect(pickups.removed).toContain(item?.id);
    expect(countOf(inventory, ItemType.Stick)).toBe(1);
  });

  it("snags an item the hook is dragged over", () => {
    const frame = frameFacingX();
    const pickups = new PickupField();
    const inventory = new Inventory();
    const rod = new Fishing();
    castAfter(rod, FISHING.chargeSeconds, frame, pickups, inventory);
    expect(rod.hooked).toBeUndefined();
    // An item between the hook and the player, on the way in.
    pickups.spawn(ItemType.Leaf, rod.hookX / 2, 0.3, 0, 0, 0);
    const leaf = pickups.items[0];
    if (leaf !== undefined) leaf.landed = true;
    run(rod, 6, reeling, frame, pickups, inventory);
    expect(countOf(inventory, ItemType.Leaf)).toBe(1);
  });

  it("lets the catch fall at the player's feet when the inventory is full", () => {
    const frame = frameFacingX();
    const inventory = new Inventory();
    while (inventory.tryAdd(ItemType.Rock)) {
      // fill every slot
    }
    const pickups = new PickupField();
    const probe = new Fishing();
    castAfter(probe, 0.55, frame, new PickupField(), new Inventory());
    pickups.spawn(ItemType.Stick, probe.hookX, 0.3, 0, 0, 0);
    const item = pickups.items[0];
    if (item !== undefined) item.landed = true;
    const rod = new Fishing();
    castAfter(rod, 0.55, frame, pickups, inventory);
    run(rod, 6, reeling, frame, pickups, inventory);
    expect(rod.events.full || pickups.items.includes(item as never)).toBe(true);
    expect(pickups.items).toHaveLength(1);
    expect(Math.hypot(item?.x ?? 99, item?.z ?? 99)).toBeLessThan(FISHING.catchRadius + 0.1);
  });

  it("stops reeling when right mouse is let go", () => {
    const frame = frameFacingX();
    const pickups = new PickupField();
    const inventory = new Inventory();
    const rod = new Fishing();
    castAfter(rod, FISHING.chargeSeconds, frame, pickups, inventory);
    run(rod, 0.5, reeling, frame, pickups, inventory);
    const x = rod.hookX;
    run(rod, 0.5, idle, frame, pickups, inventory);
    expect(rod.state).toBe(FishingState.Resting);
    expect(rod.hookX).toBeCloseTo(x, 3);
  });
});

describe("line length", () => {
  it("drags the hook after the player once the line is taut", () => {
    const frame = frameFacingX();
    const pickups = new PickupField();
    const inventory = new Inventory();
    const rod = new Fishing();
    castAfter(rod, FISHING.chargeSeconds, frame, pickups, inventory);
    // Walk away from the hook, backwards along the cast, past the line's length.
    frame.tipX = -10;
    frame.playerX = -10;
    run(rod, 0.2, idle, frame, pickups, inventory);
    const distance = Math.hypot(rod.hookX - frame.tipX, rod.hookY - frame.tipY, rod.hookZ - frame.tipZ);
    expect(distance).toBeLessThanOrEqual(FISHING.maxLineLength + 1e-6);
  });

  it("winds the line up and lets go of a hooked item when the rod is put away", () => {
    const frame = frameFacingX();
    const probe = new Fishing();
    castAfter(probe, 0.55, frame, new PickupField(), new Inventory());
    const pickups = new PickupField();
    pickups.spawn(ItemType.Stick, probe.hookX, 0.3, 0, 0, 0);
    const item = pickups.items[0];
    if (item !== undefined) item.landed = true;
    const rod = new Fishing();
    castAfter(rod, 0.55, frame, pickups, new Inventory());
    expect(rod.hooked).toBe(item);
    rod.update(DT, { active: false, cast: false, reel: false }, frame, flat, pickups, new Inventory());
    expect(rod.state).toBe(FishingState.Stowed);
    expect(rod.hooked).toBeUndefined();
    expect(pickups.items).toHaveLength(1);
  });
});
