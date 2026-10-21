import { describe, expect, it } from "vitest";

import type { Trunk } from "../items/snowball.ts";
import { PROP_METRICS } from "../worldgen/props.ts";
import { SyncChunkSource } from "./chunkSource.ts";
import { VOXEL_SIZE } from "./constants.ts";
import { PROP_DAMAGE, propBox, propColliders, sectionTouching } from "./propDamage.ts";
import { SceneSolidQuery, type YawBox } from "./sceneQuery.ts";
import { type ChunkSink, type Prop, World } from "./world.ts";

class HouseSink implements ChunkSink {
  readonly changed: { id: number; broken: number }[] = [];
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
    this.changed.push({ id: prop.id, broken: prop.broken });
  }
  onRockPlaced(): void {}
}

const breakable = PROP_METRICS.gbreadhouse_1.breakable;
if (breakable === undefined) throw new Error("the house is not breakable");

function house(yaw = 0): { world: World; sink: HouseSink; prop: Prop } {
  const world = new World(1337, new SyncChunkSource(1337), 2);
  const sink = new HouseSink();
  world.update(0, 0, sink);
  while (world.pendingCount > 0) world.drain(sink, Number.POSITIVE_INFINITY);
  const y = world.surfaceHeightVoxels(0, 0) * VOXEL_SIZE;
  const prop = world.addProp("gbreadhouse_1", 0.05, y, 0.05, yaw, 0.8, sink, ["eggnog"]);
  return { world, sink, prop };
}

describe("a gingerbread house", () => {
  it("takes its hits from any face, then explodes and lets out what was inside", () => {
    const { world, sink, prop } = house();
    for (let i = 0; i < breakable.hits - 1; i++) {
      expect(world.damageBreakable(prop.id, PROP_DAMAGE.chup, sink)).toEqual({ destroyed: false, released: [] });
    }
    expect(world.getProp(prop.id)).toBe(prop);
    expect(sink.changed).toHaveLength(0);

    const last = world.damageBreakable(prop.id, PROP_DAMAGE.chup, sink);
    expect(last).toEqual({ destroyed: true, released: ["eggnog"] });
    // The sink is told with it still whole, marked broken, and then it goes for good.
    expect(sink.changed).toEqual([{ id: prop.id, broken: 1 }]);
    expect(sink.unloaded).toContain(prop.id);
    expect(world.getProp(prop.id)).toBeUndefined();
    expect(world.damageBreakable(prop.id, 1, sink)).toBeUndefined();
  });

  it("goes quicker to a rock than to a snowball", () => {
    expect(PROP_DAMAGE.rock).toBeGreaterThan(PROP_DAMAGE.chup);
    const { world, sink, prop } = house();
    const rocks = Math.ceil(breakable.hits / PROP_DAMAGE.rock);
    let result;
    for (let i = 0; i < rocks; i++) result = world.damageBreakable(prop.id, PROP_DAMAGE.rock, sink);
    expect(result?.destroyed).toBe(true);
  });

  it("does nothing to a prop that is not breakable", () => {
    const { world, sink, prop } = house();
    const present = world.addProp("present_small", 3, prop.y, 3, 0, 0.3, sink);
    expect(world.damageBreakable(present.id, 99, sink)).toBeUndefined();
  });

  it("is aimed at as a cylinder round it, tall enough for the chimney", () => {
    const { prop } = house();
    expect(prop.radius).toBeGreaterThan(breakable.halfX * prop.scale);
    expect(prop.height).toBeCloseTo(PROP_METRICS.gbreadhouse_1.height * prop.scale);
  });
});

describe("a house is solid", () => {
  it("is a box the player is stopped by, turned with the house, and open above the walls", () => {
    for (const yaw of [0, 0.7, 2.4]) {
      const { prop } = house(yaw);
      const boxes: YawBox[] = [];
      propBox(prop, boxes);
      expect(boxes).toHaveLength(1);
      const query = new SceneSolidQuery({ isSolid: () => false });
      query.boxes.push(...boxes);
      const solid = (lx: number, ly: number, lz: number): boolean => {
        const s = prop.scale;
        const x = prop.x + (lx * Math.cos(yaw) + lz * Math.sin(yaw)) * s;
        const z = prop.z + (-lx * Math.sin(yaw) + lz * Math.cos(yaw)) * s;
        const y = prop.y + ly * s;
        return query.isSolid(Math.floor(x / VOXEL_SIZE), Math.floor(y / VOXEL_SIZE), Math.floor(z / VOXEL_SIZE));
      };
      expect(solid(0, 1, 0)).toBe(true);
      expect(solid(1.3, 1, -1.3)).toBe(true);
      expect(solid(1.8, 1, 0)).toBe(false);
      expect(solid(0, 2.9, 0)).toBe(false);
    }
  });

  it("gives rolling snow a round to meet that fits inside the box", () => {
    const { prop } = house();
    const trunks: Trunk[] = [];
    propColliders(prop, trunks);
    expect(trunks).toHaveLength(1);
    expect(trunks[0]?.radius).toBeCloseTo(breakable.halfX * prop.scale);
    expect(trunks[0]?.y0).toBeCloseTo(prop.y);
  });

  it("is touched by a ball against its side and not by one well clear", () => {
    const { prop } = house();
    const side = prop.x + breakable.halfX * prop.scale + 0.2;
    expect(sectionTouching(prop, side, prop.y + 0.5, prop.z, 0.1)).toBe(0);
    expect(sectionTouching(prop, side + 3, prop.y + 0.5, prop.z, 0.1)).toBe(-1);
    expect(sectionTouching(prop, side, prop.y + 6, prop.z, 0.1)).toBe(-1);
  });
});
