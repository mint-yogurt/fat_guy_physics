import { describe, expect, it } from "vitest";

import { SyncChunkSource } from "../sim/chunkSource.ts";
import { VOXEL_SIZE } from "../sim/constants.ts";
import { createBiomeWeights } from "../worldgen/biome.ts";
import { type ChunkSink, type Prop, World } from "../sim/world.ts";
import {
  CONTAINER_ITEMS,
  CONTAINER_KINDS,
  ContainerField,
  ContainerStorage,
  containerKindOfItem,
  inContainerReach,
  takeAll,
} from "./container.ts";
import { Inventory, ItemType, MAX_STACK, TOTAL_SLOTS, itemDisplayName } from "./inventory.ts";

describe("item names the player sees", () => {
  it("calls the can mowden lightning, and spaces out the rest", () => {
    expect(itemDisplayName(ItemType.MountainLightning)).toBe("mowden lightning");
    expect(itemDisplayName(ItemType.XmasLights)).toBe("xmas lights");
    expect(itemDisplayName(ItemType.Coal)).toBe("coal");
  });
});

describe("taking everything out of a container", () => {
  it("moves every stack into the inventory and empties the container", () => {
    const storage = new ContainerStorage(4, 2);
    storage.tryAdd(ItemType.Rock, 3);
    storage.tryAdd(ItemType.Coal, 2);
    storage.tryAdd(ItemType.Candy, 1);
    const inventory = new Inventory();
    inventory.tryAdd(ItemType.Rock, 4);
    expect(takeAll(storage, inventory)).toBe(6);
    expect(storage.isEmpty).toBe(true);
    // The rocks joined the stack already there.
    expect(inventory.slot(1)).toEqual({ type: ItemType.Rock, count: 7 });
    expect(inventory.slot(2)).toEqual({ type: ItemType.Coal, count: 2 });
    expect(inventory.slot(3)).toEqual({ type: ItemType.Candy, count: 1 });
  });

  it("leaves in the container whatever does not fit", () => {
    const storage = new ContainerStorage(2, 1);
    storage.tryAdd(ItemType.Rock, 100);
    storage.tryAdd(ItemType.Coal, 5);
    const inventory = new Inventory();
    // Fill every slot but one with sticks, and that one nearly with rocks.
    for (let i = 1; i < TOTAL_SLOTS - 1; i++) inventory.setSlot(i, { type: ItemType.Stick, count: 1 });
    inventory.setSlot(TOTAL_SLOTS - 1, { type: ItemType.Rock, count: MAX_STACK - 10 });
    expect(takeAll(storage, inventory)).toBe(10);
    expect(storage.slot(0)).toEqual({ type: ItemType.Rock, count: 90 });
    expect(storage.slot(1)).toEqual({ type: ItemType.Coal, count: 5 });
    expect(inventory.slot(TOTAL_SLOTS - 1)).toEqual({ type: ItemType.Rock, count: MAX_STACK });
  });
});

describe("container storage", () => {
  it("reports when it goes empty or not", () => {
    const storage = new ContainerStorage(4, 2);
    const seen: boolean[] = [];
    storage.onEmptyChanged = (empty) => seen.push(empty);
    expect(storage.isEmpty).toBe(true);
    storage.tryAdd(ItemType.Rock, 2);
    storage.tryAdd(ItemType.Rock, 2);
    expect(seen).toEqual([false]);
    storage.setSlot(0, undefined);
    expect(seen).toEqual([false, true]);
  });

  it("refuses an add that will not all fit", () => {
    const storage = new ContainerStorage(1, 1);
    expect(storage.tryAdd(ItemType.Rock, 255)).toBe(true);
    expect(storage.tryAdd(ItemType.Rock, 1)).toBe(false);
    expect(storage.tryAdd(ItemType.Stick, 1)).toBe(false);
  });

  it("maps every container to its own item and back", () => {
    for (const kind of CONTAINER_KINDS) expect(containerKindOfItem(CONTAINER_ITEMS[kind])).toBe(kind);
    expect(containerKindOfItem(ItemType.Rock)).toBeUndefined();
  });
});

describe("container field", () => {
  it("starts empty, and keeps what is put in", () => {
    const field = new ContainerField();
    const prop = { id: 7, kind: "present_small", loot: [] } as const;
    expect(field.isEmpty(prop)).toBe(true);
    field.storageFor(prop).tryAdd(ItemType.Stick, 3);
    expect(field.isEmpty(prop)).toBe(false);
    expect(field.storageFor(prop).slot(0)).toEqual({ type: ItemType.Stick, count: 3 });
  });

  it("fills from the loot on the prop, ignoring names with no item yet", () => {
    const field = new ContainerField();
    const prop = { id: 8, kind: "present_big", loot: ["stick", "zinc", "rock"] } as const;
    expect(field.isEmpty(prop)).toBe(false);
    const storage = field.storageFor(prop);
    expect(storage.slot(0)?.type).toBe(ItemType.Stick);
    expect(storage.slot(1)?.type).toBe(ItemType.Rock);
  });

  it("tells the prop when it empties", () => {
    const field = new ContainerField();
    const seen: [number, boolean][] = [];
    field.onEmptyChanged = (id, empty) => seen.push([id, empty]);
    const storage = field.storageFor({ id: 3, kind: "bucket_candy", loot: [] });
    storage.tryAdd(ItemType.Leaf);
    storage.setSlot(0, undefined);
    expect(seen).toEqual([
      [3, false],
      [3, true],
    ]);
  });
});

describe("world props the player adds and removes", () => {
  class PropSink implements ChunkSink {
    readonly placed: Prop[] = [];
    readonly unloaded: number[] = [];
    onChunkLoaded(): void {}
    onChunkUnloaded(): void {}
    onChunkRemeshed(): void {}
    onTreePlaced(): void {}
    onTreeFoliageRemoved(): void {}
    onTreeLightsRemoved(): void {}
    onTreeCut(): void {}
    onBushPlaced(): void {}
    onTreeUnloaded(): void {}
    onPropPlaced(prop: Prop): void {
      this.placed.push(prop);
    }
    onPropUnloaded(id: number): void {
      this.unloaded.push(id);
    }
    onRockPlaced(): void {}
  }

  function settle(world: World, sink: PropSink, x: number, z: number): void {
    world.update(x, z, sink);
    while (world.pendingCount > 0) world.drain(sink, Number.POSITIVE_INFINITY);
  }

  it("keeps a placed container across its chunk streaming out and back", () => {
    const world = new World(1337, new SyncChunkSource(1337), 2);
    const sink = new PropSink();
    settle(world, sink, 0, 0);

    const y = world.surfaceHeightVoxels(0, 0) * VOXEL_SIZE;
    const prop = world.addProp("present_small", 0.05, y, 0.05, 1, 0.3, sink);
    expect(world.getProp(prop.id)).toBe(prop);
    expect(sink.placed.at(-1)).toBe(prop);

    settle(world, sink, 500, 500);
    expect(world.getProp(prop.id)).toBeUndefined();
    expect(sink.unloaded).toContain(prop.id);

    const before = sink.placed.length;
    settle(world, sink, 0, 0);
    expect(sink.placed.slice(before).map((p) => p.id)).toContain(prop.id);
    expect(world.getProp(prop.id)?.kind).toBe("present_small");
  });

  it("forgets a removed placed container for good", () => {
    const world = new World(1337, new SyncChunkSource(1337), 2);
    const sink = new PropSink();
    settle(world, sink, 0, 0);
    const y = world.surfaceHeightVoxels(0, 0) * VOXEL_SIZE;
    const prop = world.addProp("bucket_candy", 0.05, y, 0.05, 0, 0.2, sink);

    expect(world.removeProp(prop.id, sink)).toBe(prop);
    expect(sink.unloaded).toContain(prop.id);
    expect(world.removeProp(prop.id, sink)).toBeUndefined();

    settle(world, sink, 500, 500);
    const before = sink.placed.length;
    settle(world, sink, 0, 0);
    expect(sink.placed.slice(before).map((p) => p.id)).not.toContain(prop.id);
  });

  it("keeps a removed generated prop gone when its chunk is regenerated", () => {
    const world = new World(1337, new SyncChunkSource(1337), 3);
    const sink = new PropSink();
    // The start is plain country with no props; walk out to a region that has some.
    const weights = createBiomeWeights();
    let x = 0;
    while (x < 20000) {
      world.biomeAtMeters(x, 0, weights);
      if (weights.christmas > 0.99) break;
      x += 25;
    }
    settle(world, sink, x, 0);
    const near: Prop[] = [];
    world.propsNear(x, 0, 1000, near);
    expect(near.length).toBeGreaterThan(0);
    const victim = near[0] as Prop;

    world.removeProp(victim.id, sink);
    expect(world.getProp(victim.id)).toBeUndefined();

    settle(world, sink, x + 800, 800);
    const before = sink.placed.length;
    settle(world, sink, x, 0);
    expect(sink.placed.slice(before).map((p) => p.id)).not.toContain(victim.id);
  }, 30000);

  it("finds a container in reach, and not one out of it", () => {
    const world = new World(1337, new SyncChunkSource(1337), 2);
    const sink = new PropSink();
    settle(world, sink, 0, 0);
    const y = world.surfaceHeightVoxels(0, 0) * VOXEL_SIZE;
    const prop = world.addProp("present_big", 0.05, y, 0.05, 0, 0.3, sink);
    expect(inContainerReach(prop, 1.5, y, 0)).toBe(true);
    expect(inContainerReach(prop, 6, y, 0)).toBe(false);
  });
});
