import { describe, expect, it } from "vitest";

import type { Trunk } from "../items/snowball.ts";
import { dropCount, OBJECT_SHEET } from "../worldgen/generationSheet.ts";
import { PROP_SECTIONS } from "../worldgen/props.ts";
import { SyncChunkSource } from "./chunkSource.ts";
import { VOXEL_SIZE } from "./constants.ts";
import {
  HIT_SPEED,
  PROP_DAMAGE,
  propColliders,
  sectionAtHeight,
  sectionTouching,
  standingSections,
} from "./propDamage.ts";
import { type ChunkSink, type Prop, World } from "./world.ts";

class PropSink implements ChunkSink {
  readonly changed: number[] = [];
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
  onPropPlaced(): void {}
  onPropUnloaded(id: number): void {
    this.unloaded.push(id);
  }
  onPropChanged(prop: Prop): void {
    this.changed.push(prop.id);
  }
  onRockPlaced(): void {}
}

function setup(): { world: World; sink: PropSink; y: number } {
  const world = new World(1337, new SyncChunkSource(1337), 2);
  const sink = new PropSink();
  world.update(0, 0, sink);
  while (world.pendingCount > 0) world.drain(sink, Number.POSITIVE_INFINITY);
  return { world, sink, y: world.surfaceHeightVoxels(0, 0) * VOXEL_SIZE };
}

/** A world height inside section `index` of a big snowman standing at ground `y`. */
function heightIn(prop: Prop, index: number): number {
  const section = (PROP_SECTIONS.snowman_big ?? [])[index];
  if (section === undefined) throw new Error("no such section");
  return prop.y + section.centre * prop.scale;
}

describe("snowbank wears away", () => {
  it("shrinks with every use, and is gone when the last is taken", () => {
    const { world, sink, y } = setup();
    const bank = world.addProp("snowbank", 0.05, y, 0.05, 0, 0.5, sink);
    const uses = OBJECT_SHEET.snowbank.resources?.[0]?.uses ?? 0;
    expect(uses).toBeGreaterThan(1);

    let lastScale = bank.scale;
    for (let i = 0; i < uses - 1; i++) {
      expect(world.harvestPropYield(bank.id, () => 0, sink)?.item).toBe("snowball");
      expect(bank.scale).toBeLessThan(lastScale);
      expect(bank.height).toBeCloseTo(1.2 * bank.scale);
      lastScale = bank.scale;
    }
    expect(world.getProp(bank.id)).toBe(bank);
    expect(sink.changed).toHaveLength(uses - 1);

    // The last handful of snow takes the bank with it.
    expect(world.harvestPropYield(bank.id, () => 0, sink)?.count).toBe(3);
    expect(world.getProp(bank.id)).toBeUndefined();
    expect(sink.unloaded).toContain(bank.id);
    expect(world.harvestPropYield(bank.id, () => 0, sink)).toBeUndefined();
  });

  it("does not shrink on a swing that gets nothing", () => {
    const { world, sink, y } = setup();
    const bank = world.addProp("snowbank", 0.05, y, 0.05, 0, 0.5, sink);
    expect(world.harvestPropYield(bank.id, () => 0.99, sink)).toBeUndefined();
    expect(bank.scale).toBe(bank.fullScale);
  });
});

describe("snowman sections", () => {
  it("is hit on the part at the height of the blow", () => {
    const { world, sink, y } = setup();
    const man = world.addProp("snowman_big", 0.05, y, 0.05, 0, 0.5, sink);
    expect(sectionAtHeight(man, heightIn(man, 0))).toBe(0);
    expect(sectionAtHeight(man, heightIn(man, 1))).toBe(1);
    expect(sectionAtHeight(man, heightIn(man, 2))).toBe(2);
    expect(sectionAtHeight(man, man.y + 50)).toBe(2);
    expect(sectionAtHeight(man, man.y - 5)).toBe(0);
  });

  it("takes several blows to take a head off, then drops the coal and shrinks to fit", () => {
    const { world, sink, y } = setup();
    const man = world.addProp("snowman_big", 0.05, y, 0.05, 0, 0.5, sink);
    const head = PROP_SECTIONS.snowman_big?.[2];
    const heightBefore = man.height;

    for (let i = 0; i < (head?.hits ?? 0) - 1; i++) {
      const hurt = world.damageProp(man.id, heightIn(man, 2), PROP_DAMAGE.chup, sink);
      expect(hurt?.section).toBe(2);
      expect(hurt?.broken).toHaveLength(0);
    }
    expect(man.broken).toBe(0);

    const off = world.damageProp(man.id, heightIn(man, 2), PROP_DAMAGE.chup, sink);
    expect(off?.broken.map((b) => b.index)).toEqual([2]);
    expect(off?.drops).toEqual([{ item: "coal", amount: 1, maxAmount: 2 }]);
    expect(off?.gone).toBe(false);
    expect(man.broken).toBe(0b100);
    expect(man.height).toBeLessThan(heightBefore);
    expect(sink.changed).toContain(man.id);
    expect(standingSections(man, PROP_SECTIONS.snowman_big ?? [])).toBe(2);

    // The head is gone, so a blow up there lands on what is left.
    expect(sectionAtHeight(man, man.y + 10)).toBe(1);
  });

  it("takes everything above a broken part with it", () => {
    const { world, sink, y } = setup();
    const man = world.addProp("snowman_big", 0.05, y, 0.05, 0, 0.5, sink);
    let off;
    for (let i = 0; i < 20 && off?.broken.length !== 2; i++) {
      off = world.damageProp(man.id, heightIn(man, 1), PROP_DAMAGE.chup, sink);
    }
    expect(off?.broken.map((b) => b.index)).toEqual([1, 2]);
    // The head was among them, so the coal came out once.
    expect(off?.drops).toEqual([{ item: "coal", amount: 1, maxAmount: 2 }]);
    expect(man.broken).toBe(0b110);
    expect(world.getProp(man.id)).toBe(man);
  });

  it("removes the snowman when the bottom comes off, for good", () => {
    const { world, sink, y } = setup();
    const man = world.addProp("snowman_small", 0.05, y, 0.05, 0, 0.5, sink);
    let result;
    for (let i = 0; i < 50 && result?.gone !== true; i++) {
      result = world.damageProp(man.id, man.y + 0.1, PROP_DAMAGE.rock, sink);
    }
    expect(result?.gone).toBe(true);
    expect(result?.broken.map((b) => b.index)).toEqual([0, 1]);
    expect(world.getProp(man.id)).toBeUndefined();
    expect(sink.unloaded).toContain(man.id);
    expect(world.damageProp(man.id, man.y + 0.1, 1, sink)).toBeUndefined();
  });

  it("does nothing to a prop that is not made of parts", () => {
    const { world, sink, y } = setup();
    const present = world.addProp("present_small", 0.05, y, 0.05, 0, 0.3, sink);
    expect(world.damageProp(present.id, present.y + 0.1, 5, sink)).toBeUndefined();
  });

  it("gives every snowman 1-2 coal, and sticks only to the big one, 2 of them", () => {
    expect(OBJECT_SHEET.snowman_small.drops).toEqual([{ item: "coal", amount: 1, maxAmount: 2 }]);
    expect(OBJECT_SHEET.snowman_big.drops).toEqual([{ item: "coal", amount: 1, maxAmount: 2 }]);
    expect(OBJECT_SHEET.snowman_small.resources).toBeUndefined();
    expect(OBJECT_SHEET.snowman_big.resources).toEqual([{ item: "stick", rarity: "common", uses: 2 }]);
  });

  it("rolls the coal between one and two, and both come up", () => {
    const coal = OBJECT_SHEET.snowman_small.drops?.[0];
    expect(coal).toBeDefined();
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 1000; i++) counts[dropCount(coal!, i / 1000)]!++;
    expect(counts[0]).toBe(0);
    expect(counts[1]).toBe(500);
    expect(counts[2]).toBe(500);
    expect(counts[3]).toBe(0);
    // A plain amount is that amount.
    expect(dropCount({ item: "stick", amount: 3 }, 0.99)).toBe(3);
  });
});

describe("snowman bodies", () => {
  it("is solid as one cylinder per standing ball, stacked from the ground", () => {
    const { world, sink, y } = setup();
    const man = world.addProp("snowman_big", 0.05, y, 0.05, 0, 0.5, sink);
    const trunks: Trunk[] = [];
    propColliders(man, trunks);
    expect(trunks).toHaveLength(3);
    expect(trunks[0]?.y0).toBeCloseTo(man.y);
    for (const trunk of trunks) {
      expect(trunk.x).toBe(man.x);
      expect(trunk.z).toBe(man.z);
      expect(trunk.radius).toBeGreaterThan(0);
      expect(trunk.y1).toBeGreaterThan(trunk.y0);
    }
    expect(trunks[2]?.y0).toBeGreaterThan(trunks[0]?.y1 ?? Infinity - 1);

    world.damageProp(man.id, heightIn(man, 2), 99, sink);
    trunks.length = 0;
    propColliders(man, trunks);
    expect(trunks).toHaveLength(2);
  });

  it("is touched by a ball at its side, and not by one well clear of it", () => {
    const { world, sink, y } = setup();
    const man = world.addProp("snowman_big", 0.05, y, 0.05, 0, 0.5, sink);
    const sideX = man.x + (PROP_SECTIONS.snowman_big?.[0]?.radius ?? 1) * man.scale + 0.1;
    expect(sectionTouching(man, sideX, heightIn(man, 0), man.z, 0.1)).toBe(0);
    expect(sectionTouching(man, sideX + 3, heightIn(man, 0), man.z, 0.1)).toBe(-1);
    expect(sectionTouching(man, man.x, heightIn(man, 2), man.z, 0.1)).toBe(2);
    expect(HIT_SPEED).toBeGreaterThan(0);
  });
});
