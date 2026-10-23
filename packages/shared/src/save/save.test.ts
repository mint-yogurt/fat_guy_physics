import { describe, expect, it } from "vitest";

import { ContainerField } from "../items/container.ts";
import { RecipeBook } from "../items/crafting.ts";
import { Inventory, ItemType, TOTAL_SLOTS } from "../items/inventory.ts";
import { PickupField } from "../items/pickupField.ts";
import { BuildField } from "../items/building.ts";
import { TrampolineField } from "../items/trampoline.ts";
import { SyncChunkSource } from "../sim/chunkSource.ts";
import { VOXEL_SIZE } from "../sim/constants.ts";
import { Player } from "../sim/player.ts";
import { World, type ChunkSink, type Tree } from "../sim/world.ts";
import {
  applyPlayer,
  applyWorld,
  capturePlayer,
  captureWorld,
  worldRevision,
  type WorldParts,
} from "./gameSave.ts";
import { MemorySaveStore } from "./saveStore.ts";
import { SAVE_VERSION, sanitizePlayerSave, sanitizeWorldSave } from "./snapshot.ts";

const SEED = 1337;
const RADIUS = 2;

class NullSink implements ChunkSink {
  onChunkLoaded(): void {}
  onChunkUnloaded(): void {}
  onChunkRemeshed(): void {}
  onTreePlaced(): void {}
  onTreeFoliageRemoved(): void {}
  onTreeLightsRemoved(): void {}
  onTreeCut(): void {}
  onBushPlaced(): void {}
  onTreeUnloaded(): void {}
  onPropPlaced(): void {}
  onPropUnloaded(): void {}
  onRockPlaced(): void {}
}

function makeParts(): WorldParts {
  return {
    world: new World(SEED, new SyncChunkSource(SEED), RADIUS),
    containers: new ContainerField(),
    trampolines: new TrampolineField(),
    pieces: new BuildField(),
    pickups: new PickupField(),
  };
}

function settle(world: World, x: number, z: number, sink: ChunkSink): void {
  world.update(x, z, sink);
  while (world.pendingCount > 0) world.drain(sink, Number.POSITIVE_INFINITY);
}

/** Through the same JSON text a real store keeps. */
function viaJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("player save", () => {
  it("round-trips position, look and inventory through a store", async () => {
    const player = new Player(12.5, 3.25, -40);
    player.setLook(33, -20);
    const inventory = new Inventory();
    inventory.tryAdd(ItemType.Stick, 7);
    inventory.tryAdd(ItemType.Skateboard);
    inventory.selectSlot(2);
    const book = new RecipeBook();
    book.observe(inventory);
    book.see(ItemType.Log);

    const store = new MemorySaveStore();
    await store.savePlayer(capturePlayer(player, inventory, book));
    const loaded = await store.loadPlayer();
    expect(loaded).toBeDefined();

    const restored = new Player(0, 0, 0);
    const restoredInventory = new Inventory();
    const restoredBook = new RecipeBook();
    applyPlayer(loaded!, restored, restoredInventory, restoredBook);

    expect([restored.x, restored.y, restored.z]).toEqual([12.5, 3.25, -40]);
    expect(restored.yaw).toBe(33);
    expect(restored.pitch).toBe(-20);
    expect(restoredInventory.slot(1)).toEqual({ type: ItemType.Stick, count: 7 });
    expect(restoredInventory.slot(2)).toEqual({ type: ItemType.Skateboard, count: 1 });
    expect(restoredInventory.selectedSlot).toBe(2);
    expect(restoredInventory.slot(0)).toBeUndefined();
    // Which recipes the player knows comes back with them.
    expect([ItemType.Stick, ItemType.Skateboard, ItemType.Log].every((type) => restoredBook.has(type))).toBe(true);
    expect(restoredBook.has(ItemType.Rock)).toBe(false);
  });

  it("does not put a player somewhere the world cannot catch them", () => {
    const save = sanitizePlayerSave({ version: 1, position: { x: 5, y: 500, z: 5 }, slots: [] })!;
    const player = new Player(0, 0, 0);
    applyPlayer(save, player, new Inventory(), new RecipeBook());
    expect(player.y).toBeLessThan(20);

    const fallen = sanitizePlayerSave({ version: 1, position: { x: 5, y: -300, z: 5 }, slots: [] })!;
    const other = new Player(1, 2, 3);
    applyPlayer(fallen, other, new Inventory(), new RecipeBook());
    expect([other.x, other.y, other.z]).toEqual([1, 2, 3]);
  });

  it("repairs or rejects garbage instead of passing it on", () => {
    expect(sanitizePlayerSave(undefined)).toBeUndefined();
    expect(sanitizePlayerSave("hello")).toBeUndefined();
    expect(sanitizePlayerSave({ version: SAVE_VERSION + 1 })).toBeUndefined();

    const messy = sanitizePlayerSave({
      version: 1,
      position: { x: Number.NaN, y: 1, z: 2 },
      yaw: "left",
      pitch: 9999,
      selected: 99,
      slots: [
        { item: "stick", count: 5 },
        { item: "zinc", count: 3 },
        { item: "rock", count: 100000 },
        { item: "leaf", count: -2 },
        "nope",
      ],
      seen: ["log", "zinc", 5],
    })!;
    expect(messy.position).toBeNull();
    expect(messy.yaw).toBe(-90);
    expect(messy.pitch).toBe(0);
    expect(messy.selected).toBe(0);
    expect(messy.slots).toHaveLength(TOTAL_SLOTS);
    // Slot 0 is the Unarmed slot and can never hold anything, whatever the file says.
    expect(messy.slots[0]).toBeNull();
    expect(messy.slots[1]).toBeNull();
    expect(messy.slots[2]).toBeNull();
    expect(messy.slots[3]).toBeNull();
    expect(messy.seen).toEqual(["log"]);
    // An old save, from before recipes were learned, has no list at all.
    expect(sanitizePlayerSave({ version: 1, slots: [] })!.seen).toEqual([]);
  });

  it("starts fresh from an unreadable save", async () => {
    const store = new MemorySaveStore();
    expect(await store.loadPlayer()).toBeUndefined();
    expect(await store.loadWorld()).toBeUndefined();
  });
});

describe("world save", () => {
  it("brings edits back into a brand new world", () => {
    const before = makeParts();
    const sink = new NullSink();

    // Stand wherever there is a tree to chop; nothing grows at the origin.
    let sx = 0;
    let sz = 0;
    let tree: Tree | undefined;
    for (let i = -4; i <= 4 && tree === undefined; i++) {
      for (let j = -4; j <= 4 && tree === undefined; j++) {
        sx = i * 20;
        sz = j * 20;
        settle(before.world, sx, sz, sink);
        tree = before.world.treesNear(sx, sz, 5, [])[0];
      }
    }
    if (tree === undefined) throw new Error("no tree found to chop");

    const vx = Math.floor(sx / VOXEL_SIZE);
    const vz = Math.floor(sz / VOXEL_SIZE);

    // A felled tree.
    for (let i = 0; i < 40; i++) {
      before.world.chopTree(tree.id, tree.y + Math.min(0.5, tree.trunkTopMeters / 2), sink);
    }
    expect(tree.severed).toBe(true);
    const cutAt = tree.trunkTopMeters;

    // A placed container with something in it, and a picked-up generated prop.
    const ground = before.world.surfaceHeightVoxels(vx, vz) * VOXEL_SIZE;
    const present = before.world.addProp("present_small", sx + 1, ground, sz + 1, 0.5, 1, sink);
    before.containers.storageFor(present).tryAdd(ItemType.Coal, 4);
    const gone = before.world.propsNear(sx, sz, 8, []).find((p) => p.id < 0x1_0000_0000);
    if (gone !== undefined) before.world.removeProp(gone.id, sink);

    // A trampoline and some dropped items.
    before.trampolines.place(sx + 5, ground, sz + 5);
    before.pieces.place(ItemType.Ladder, sx + 6, ground + 1.5, sz + 6, { x: 0, y: 1, z: 0, w: 0 }, true);
    before.pickups.spawn(ItemType.Stick, sx + 3, ground + 1, sz + 3, ground, 0);
    before.pickups.spawnStuck(ItemType.Stick, sx + 4, ground + 1, sz + 4, 0, -1, 0, 0);

    const saved = sanitizeWorldSave(viaJson(captureWorld(before)))!;
    expect(saved).toBeDefined();

    const after = makeParts();
    applyWorld(saved, after, () => ground, 0);
    settle(after.world, sx, sz, sink);

    const sameTree = after.world.getTree(tree.id);
    expect(sameTree?.severed).toBe(true);
    expect(sameTree?.trunkTopMeters).toBeCloseTo(cutAt, 5);

    const restoredPresent = after.world.getProp(present.id);
    expect(restoredPresent?.kind).toBe("present_small");
    expect(restoredPresent?.x).toBe(sx + 1);
    expect(after.containers.storageFor(present).slot(0)).toEqual({ type: ItemType.Coal, count: 4 });
    if (gone !== undefined) expect(after.world.getProp(gone.id)).toBeUndefined();

    expect(after.trampolines.items).toHaveLength(1);
    expect(after.pieces.pieces).toHaveLength(1);
    expect(after.pieces.pieces[0]?.spec.item).toBe(ItemType.Ladder);
    expect(after.pieces.pieces[0]?.fixed).toBe(true);
    expect(after.pickups.items).toHaveLength(2);
    expect(after.pickups.items.filter((p) => p.stuck !== undefined)).toHaveLength(1);

    // And placing one more must not reuse an id.
    const next = after.world.addProp("present_small", sx + 2, ground, sz + 2, 0, 1, sink);
    expect(next.id).toBeGreaterThan(present.id);
  });

  it("remembers an emptied container as empty rather than refilling it", () => {
    const parts = makeParts();
    const prop = { id: 77, kind: "present_small", loot: ["coal"] } as const;
    const storage = parts.containers.storageFor(prop);
    expect(storage.isEmpty).toBe(false);
    storage.setSlot(0, undefined);
    expect(storage.isEmpty).toBe(true);

    const fresh = new ContainerField();
    for (const saved of parts.containers.exportAll()) fresh.restore(saved);
    expect(fresh.isEmpty(prop)).toBe(true);
  });

  it("drops a saved piece of an item that is not a building piece, and mends a broken rotation", () => {
    const saved = captureWorld(makeParts());
    const odd = sanitizeWorldSave(
      viaJson({
        ...saved,
        pieces: [
          { item: "stick", x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, fixed: true },
          { item: "plywood", x: 1, y: 2, z: 3, qx: 0, qy: 0, qz: 0, qw: 0, fixed: false },
          { item: "ladder", x: "far", y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, fixed: true },
        ],
      }),
    );
    expect(odd?.pieces).toHaveLength(1);
    expect(odd?.pieces[0]?.item).toBe("plywood");
    expect(odd?.pieces[0]?.qw).toBe(1);
  });

  it("loads a save from before pieces existed", () => {
    const saved = captureWorld(makeParts()) as unknown as Record<string, unknown>;
    delete saved.pieces;
    expect(sanitizeWorldSave(viaJson(saved))?.pieces).toEqual([]);
  });

  it("ignores a save from another seed", () => {
    const parts = makeParts();
    const saved = captureWorld(parts);
    const other = new World(SEED + 1, new SyncChunkSource(SEED + 1), RADIUS);
    const target: WorldParts = { ...makeParts(), world: other };
    expect(() => applyWorld({ ...saved, trampolines: [{ x: 0, baseY: 0, z: 0 }] }, target, () => 0, 0)).not.toThrow();
    expect(target.trampolines.items).toHaveLength(0);
  });

  it("refuses to import once chunks are streaming", () => {
    const parts = makeParts();
    parts.world.update(0, 0, new NullSink());
    expect(() => parts.world.importEdits(captureWorld(parts))).toThrow();
  });

  it("filters nonsense out of a world save", () => {
    expect(sanitizeWorldSave({ version: 1 })).toBeUndefined();
    const messy = sanitizeWorldSave({
      version: 1,
      seed: SEED,
      placedProps: [{ id: 1, kind: "toString", x: 0, y: 0, z: 0, scale: 1 }, { id: 2, kind: "present_small", x: 0, y: 0, z: 0, scale: 1 }],
      pickups: [{ item: "zinc", x: 0, y: 0, z: 0 }, { item: "stick", x: 1, y: 2, z: 3 }],
      nextPlacedPropId: 3,
    })!;
    expect(messy.placedProps.map((p) => p.id)).toEqual([2]);
    expect(messy.pickups).toHaveLength(1);
    expect(messy.nextPlacedPropId).toBe(3);
  });

  it("changes its revision when something worth saving changes", () => {
    const parts = makeParts();
    const sink = new NullSink();
    settle(parts.world, 0, 0, sink);
    const start = worldRevision(parts);
    expect(worldRevision(parts)).toBe(start);
    parts.world.addProp("present_small", 1, 0, 1, 0, 1, sink);
    expect(worldRevision(parts)).not.toBe(start);
  });
});
