import { describe, expect, it } from "vitest";

import { SyncChunkSource } from "../sim/chunkSource.ts";
import type { ChunkSink } from "../sim/world.ts";
import { CHUNK_METERS, World } from "../sim/world.ts";
import { MAP_TILE_PX, MapData } from "./mapData.ts";

const sink: ChunkSink = {
  onChunkLoaded() {},
  onChunkUnloaded() {},
  onChunkRemeshed() {},
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
    const before = tile.slice();
    world.digSphere(CHUNK_METERS / 2, world.surfaceHeightVoxels(16, 16) * 0.1, CHUNK_METERS / 2, 1, sink);

    // An unforced sweep leaves what was already seen alone...
    map.explore(0, 0, 2, false);
    map.refresh(world, 1e9);
    expect(map.tile(0, 0)).toEqual(before);
    // ...a forced one (the player is here) shows the dig.
    map.explore(0, 0, 2, true);
    map.refresh(world, 1e9);
    expect(map.tile(0, 0)).not.toEqual(before);
  });
});
