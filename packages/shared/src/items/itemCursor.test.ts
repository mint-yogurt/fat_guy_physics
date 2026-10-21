import { describe, expect, it } from "vitest";

import { ContainerStorage } from "./container.ts";
import { Inventory, ItemType, MAX_STACK } from "./inventory.ts";
import { ItemCursor } from "./itemCursor.ts";

function filled(): Inventory {
  const inventory = new Inventory();
  inventory.setSlot(1, { type: ItemType.Stick, count: 3 });
  inventory.setSlot(2, { type: ItemType.Rock, count: 5 });
  inventory.setSlot(9, { type: ItemType.Stick, count: MAX_STACK });
  return inventory;
}

describe("item cursor", () => {
  it("picks a whole stack up and puts it down in an empty slot", () => {
    const inventory = filled();
    const cursor = new ItemCursor();
    expect(cursor.click(inventory, 1)).toBe(true);
    expect(cursor.held).toEqual({ type: ItemType.Stick, count: 3 });
    expect(inventory.slot(1)).toBeUndefined();

    expect(cursor.click(inventory, 12)).toBe(true);
    expect(cursor.held).toBeUndefined();
    expect(inventory.slot(12)).toEqual({ type: ItemType.Stick, count: 3 });
  });

  it("does nothing when an empty hand clicks an empty slot", () => {
    const cursor = new ItemCursor();
    expect(cursor.click(new Inventory(), 5)).toBe(false);
    expect(cursor.empty).toBe(true);
  });

  it("swaps with a different item", () => {
    const inventory = filled();
    const cursor = new ItemCursor();
    cursor.click(inventory, 1);
    cursor.click(inventory, 2);
    expect(inventory.slot(2)).toEqual({ type: ItemType.Stick, count: 3 });
    expect(cursor.held).toEqual({ type: ItemType.Rock, count: 5 });
  });

  it("combines the same item, keeping the overflow in hand", () => {
    const inventory = filled();
    inventory.setSlot(10, { type: ItemType.Stick, count: MAX_STACK - 1 });
    const cursor = new ItemCursor();
    cursor.click(inventory, 1);
    cursor.click(inventory, 10);
    expect(inventory.slot(10)?.count).toBe(MAX_STACK);
    expect(cursor.held).toEqual({ type: ItemType.Stick, count: 2 });
  });

  it("leaves a full stack alone when the same item is put on it", () => {
    const inventory = filled();
    const cursor = new ItemCursor();
    cursor.click(inventory, 1);
    expect(cursor.click(inventory, 9)).toBe(false);
    expect(cursor.held?.count).toBe(3);
  });

  it("never puts anything in the unarmed slot", () => {
    const inventory = filled();
    const cursor = new ItemCursor();
    cursor.click(inventory, 1);
    expect(cursor.click(inventory, 0)).toBe(false);
    expect(inventory.slot(0)).toBeUndefined();
    expect(cursor.held).toBeDefined();
  });

  it("moves between grids", () => {
    const inventory = filled();
    const chest = new ContainerStorage(4, 2);
    const cursor = new ItemCursor();
    cursor.click(inventory, 2);
    cursor.click(chest, 3);
    expect(chest.slot(3)).toEqual({ type: ItemType.Rock, count: 5 });
    expect(chest.isEmpty).toBe(false);
    cursor.click(chest, 3);
    cursor.click(inventory, 20);
    expect(chest.isEmpty).toBe(true);
    expect(inventory.slot(20)?.type).toBe(ItemType.Rock);
  });

  it("cancels back to where it came from", () => {
    const inventory = filled();
    const cursor = new ItemCursor();
    cursor.click(inventory, 1);
    expect(cursor.cancel()).toBeUndefined();
    expect(inventory.slot(1)).toEqual({ type: ItemType.Stick, count: 3 });
    expect(cursor.empty).toBe(true);
  });

  it("cancels into another slot if the origin was refilled meanwhile", () => {
    const inventory = filled();
    const cursor = new ItemCursor();
    cursor.click(inventory, 1);
    inventory.setSlot(1, { type: ItemType.Leaf, count: 1 });
    expect(cursor.cancel()).toBeUndefined();
    expect(inventory.slot(1)?.type).toBe(ItemType.Leaf);
    expect(inventory.slot(3)).toEqual({ type: ItemType.Stick, count: 3 });
  });

  it("hands back what cannot be returned at all", () => {
    const chest = new ContainerStorage(1, 1);
    chest.setSlot(0, { type: ItemType.Rock, count: 2 });
    const cursor = new ItemCursor();
    cursor.click(chest, 0);
    chest.setSlot(0, { type: ItemType.Leaf, count: 1 });
    expect(cursor.cancel()).toEqual({ type: ItemType.Rock, count: 2 });
  });
});
