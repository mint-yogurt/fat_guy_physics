import { describe, expect, it } from "vitest";

import { Inventory, ItemType, MAX_STACK, TOTAL_SLOTS } from "./inventory.ts";

describe("inventory stacks", () => {
  it("stacks the same item in one slot", () => {
    const inventory = new Inventory();
    inventory.tryAdd(ItemType.XmasLights, 10);
    inventory.tryAdd(ItemType.XmasLights, 5);
    expect(inventory.slot(1)).toEqual({ type: ItemType.XmasLights, count: 15 });
    expect(inventory.slot(2)).toBeUndefined();
  });

  it("holds 255 to a slot and spills the rest into the next", () => {
    const inventory = new Inventory();
    expect(inventory.tryAdd(ItemType.XmasLights, 300)).toBe(true);
    expect(inventory.slot(1)?.count).toBe(MAX_STACK);
    expect(inventory.slot(2)).toEqual({ type: ItemType.XmasLights, count: 45 });
  });

  it("adds nothing at all when it will not all fit", () => {
    const inventory = new Inventory();
    expect(inventory.tryAdd(ItemType.XmasLights, MAX_STACK * (TOTAL_SLOTS - 1))).toBe(true);
    expect(inventory.tryAdd(ItemType.XmasLights, 1)).toBe(false);
    expect(inventory.tryAdd(ItemType.Stick, 1)).toBe(false);
    expect(inventory.slot(1)?.count).toBe(MAX_STACK);
  });

  it("uses a stack up one at a time", () => {
    const inventory = new Inventory();
    inventory.tryAdd(ItemType.XmasLights, 2);
    inventory.selectSlot(1);
    expect(inventory.tryConsumeSelected()).toBe(true);
    expect(inventory.selectedItem()?.count).toBe(1);
    expect(inventory.tryConsumeSelected()).toBe(true);
    expect(inventory.selectedItem()).toBeUndefined();
  });
});
