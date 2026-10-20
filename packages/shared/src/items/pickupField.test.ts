import { describe, expect, it } from "vitest";

import { Inventory, ItemType } from "./inventory.ts";
import { PickupField } from "./pickupField.ts";

const flat = (): number => 0;

describe("PickupField", () => {
  it("throws an item out, lands it, and does not collect it on its own", () => {
    const field = new PickupField();
    field.spawn(ItemType.Stick, 0, 1, 0, 0, 0, 2, 2, 0);
    for (let t = 0; t < 120; t++) field.update(1 / 60, t / 60, flat);
    const item = field.items[0];
    expect(item?.landed).toBe(true);
    expect(item?.x ?? 0).toBeGreaterThan(0.5);
    expect(field.items).toHaveLength(1);
  });

  it("targets the item on the crosshair and collects it into the inventory", () => {
    const field = new PickupField();
    const inventory = new Inventory();
    field.spawn(ItemType.Log, 0, 0.3, -2, 0, 0);
    field.spawn(ItemType.Leaf, 3, 0.3, 0, 0, 0);
    field.update(1 / 60, 0, flat);
    // Eye at 1.6m, looking down at the log.
    const dir = { x: 0, y: -1.3, z: -2 };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    const target = field.target(0, 1.6, 0, dir.x / len, dir.y / len, dir.z / len, 9, 0, 9);
    expect(target?.type).toBe(ItemType.Log);
    if (target === undefined) return;
    expect(field.collect(target, inventory)).toBe(true);
    expect(field.items).toHaveLength(1);
    expect(field.removed).toContain(target.id);
    expect(inventory.slot(1)).toEqual({ type: ItemType.Log, count: 1 });
  });

  it("leaves a stuck stick where it went in", () => {
    const field = new PickupField();
    field.spawnStuck(ItemType.Stick, 1, 2, 3, 0, -1, 0, 0);
    for (let t = 0; t < 60; t++) field.update(1 / 60, t / 60, flat);
    expect(field.items[0]).toMatchObject({ x: 1, y: 2, z: 3, stuck: { x: 0, y: -1, z: 0 } });
  });
});
