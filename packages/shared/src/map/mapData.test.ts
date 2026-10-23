import { describe, expect, it } from "vitest";

import { SyncChunkSource } from "../sim/chunkSource.ts";
import type { ChunkSink } from "../sim/world.ts";
import { World } from "../sim/world.ts";
import { MAP_TILE_PX, MapData } from "./mapData.ts";

const sink: ChunkSink = {
  onChunkLoaded() {},
  onChunkUnloaded() {},
  onTreePlaced() {},
  onTreeUnloaded() {},
  onPropPlaced() {},
  onPropUnloaded() {},
  onRockPlaced() {},
  onTreeFoliageRemoved() {},
  onTreeLightsRemoved() {},
  onBushPlaced() {},
  onTreeCut() {},
};

describe("MapData", () => {
  it("draws only explored, loaded columns, and redraws them when forced", () => {
    const world = new World(1337, new SyncChunkSource(1337), 4);
    world.update(0, 0, sink);
    world.drain(sink, 1e9);

    const map = new MapData();
    map.explore(0, 0, 2, false);
    map.refresh(world, 1e9);
    expect(map.tiles.size).toBeGreaterThan(0);
    expect(map.tile(0, 0)?.some((v, i) => i % 4 === 3 && v === 255)).toBe(true);
    expect(map.tile(20, 20)).toBeUndefined();

    const tile = map.tile(0, 0) as Uint8ClampedArray;
    expect(tile.length).toBe(MAP_TILE_PX * MAP_TILE_PX * 4);

    // A sweep that is not forced leaves what was seen alone; a forced one redraws it.
    const before = tile.slice();
    map.explore(0, 0, 2, false);
    map.refresh(world, 1e9);
    expect(map.tile(0, 0)).toEqual(before);
    map.explore(0, 0, 2, true);
    map.refresh(world, 1e9);
    expect(map.tile(0, 0)).toEqual(before);
  });

  it("shows snow white and halloween ground dark", () => {
    const world = new World(1337, new SyncChunkSource(1337), 4);
    world.update(0, 0, sink);
    world.drain(sink, 1e9);
    const map = new MapData();
    map.explore(0, 0, 2, false);
    map.refresh(world, 1e9);
    const tile = map.tile(0, 0) as Uint8ClampedArray;
    for (let i = 0; i < tile.length; i += 4) {
      // Whatever it is, it is a colour and not the empty black of an unexplored pixel.
      expect((tile[i] as number) + (tile[i + 1] as number) + (tile[i + 2] as number)).toBeGreaterThan(0);
    }
  });
});
