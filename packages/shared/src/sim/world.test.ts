import { describe, expect, it } from "vitest";

import { chunkKey, keyX, keyY, keyZ } from "./chunkKey.ts";
import { GROUND_FLOATS_PER_VERTEX } from "../worldgen/groundMesh.ts";
import { LATTICE_SIDE } from "../worldgen/groundField.ts";
import { type ChunkResult, SyncChunkSource } from "./chunkSource.ts";
import { VOXEL_SIZE } from "./constants.ts";
import {
  CHUNK_METERS,
  type ChunkSink,
  desiredChunkSet,
  World,
} from "./world.ts";

describe("chunkKey", () => {
  it("round-trips coordinates including negatives", () => {
    for (const cx of [0, 1, -1, 7, -7, 1000, -1000, 524287, -524288]) {
      for (const cz of [0, 1, -1, 31, -31, 99999, -99999]) {
        for (const cy of [0, 3, -1, 127, -128]) {
          const key = chunkKey(cx, cy, cz);
          expect(Number.isSafeInteger(key)).toBe(true);
          expect([keyX(key), keyY(key), keyZ(key)]).toEqual([cx, cy, cz]);
        }
      }
    }
  });

  it("never collides across a dense neighbourhood", () => {
    // The whole point of a packed key is that distinct coords stay distinct;
    // a bit-width mistake shows up as two chunks sharing a slot, which would
    // look like random holes in the world rather than an error.
    const seen = new Set<number>();
    let count = 0;
    for (let cx = -12; cx <= 12; cx++) {
      for (let cz = -12; cz <= 12; cz++) {
        for (let cy = -2; cy <= 6; cy++) {
          seen.add(chunkKey(cx, cy, cz));
          count++;
        }
      }
    }
    expect(seen.size).toBe(count);
  });
});

describe("desiredChunkSet", () => {
  const layers = 1;

  function columnsForRadius(radius: number): number {
    let columns = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx * dx + dz * dz <= radius * radius) columns++;
      }
    }
    return columns;
  }

  it("fills a disc of single-layer tiles", () => {
    const out = desiredChunkSet(0, 0, 6, new Set());
    expect(out.size).toBe(columnsForRadius(6) * layers);

    for (const key of out) {
      const y = keyY(key);
      expect(y).toBe(0);
      expect(keyX(key) ** 2 + keyZ(key) ** 2).toBeLessThanOrEqual(36);
    }
  });

  it("translates with the centre rather than changing shape", () => {
    const origin = desiredChunkSet(0, 0, 6, new Set());
    const shifted = desiredChunkSet(-40, 17, 6, new Set());
    expect(shifted.size).toBe(origin.size);
    for (const key of origin) {
      expect(shifted.has(chunkKey(keyX(key) - 40, keyY(key), keyZ(key) + 17))).toBe(true);
    }
  });

  it("overlaps heavily with the neighbouring centre, so a crossing loads a crescent", () => {
    // This is the property that makes streaming cheap: stepping one chunk
    // sideways must re-use almost everything. If it ever stops holding, every
    // boundary crossing becomes a full reload and the frame time explodes.
    const here = desiredChunkSet(0, 0, 6, new Set());
    const there = desiredChunkSet(1, 0, 6, new Set());
    let fresh = 0;
    for (const key of there) if (!here.has(key)) fresh++;
    expect(fresh).toBeLessThan(here.size * 0.15);
  });

  it("clears the output set so the caller can reuse one allocation", () => {
    const out = new Set([chunkKey(999, 0, 999)]);
    desiredChunkSet(0, 0, 1, out);
    expect(out.has(chunkKey(999, 0, 999))).toBe(false);
    expect(out.size).toBe(columnsForRadius(1) * layers);
  });
});

describe("World streaming", () => {
  /** Records lifecycle calls so a test can assert on them. */
  class RecordingSink implements ChunkSink {
    readonly loaded: number[] = [];
    readonly unloaded: number[] = [];
    /** Summed to prove the buffers handed over are real mesh data. */
    totalVertices = 0;

    onChunkLoaded(result: ChunkResult): void {
      this.loaded.push(result.key);
      this.totalVertices += result.vertexCount;
      // The contract is "exactly vertexCount long, no slack" -- geometry
      // uploads the whole buffer, so slack would render as garbage.
      expect(result.vertices.length).toBe(result.vertexCount * GROUND_FLOATS_PER_VERTEX);
      expect(result.lattice.length).toBe(LATTICE_SIDE * LATTICE_SIDE);
    }
    onChunkUnloaded(key: number): void {
      this.unloaded.push(key);
    }
    onTreePlaced(): void {}
    onTreeFoliageRemoved(): void {}
    onTreeLightsRemoved(): void {}
    onTreeCut(): void {}
    onBushPlaced(): void {}
    onTreeUnloaded(): void {}
    onPropPlaced(): void {}
    onPropUnloaded(): void {}
    onRockPlaced(): void {}
    reset(): void {
      this.loaded.length = 0;
      this.unloaded.length = 0;
    }
  }

  const RADIUS = 2;

  /** Drains until the source runs dry, ignoring the per-frame budget. */
  function drainAll(world: World, sink: RecordingSink): void {
    while (world.pendingCount > 0) world.drain(sink, Number.POSITIVE_INFINITY);
  }

  function makeWorld(radius = RADIUS): World {
    return new World(1337, new SyncChunkSource(1337), radius);
  }

  it("loads the full cylinder on the first update and nothing on the second", () => {
    const world = makeWorld();
    const sink = new RecordingSink();
    const expected = desiredChunkSet(0, 0, RADIUS, new Set()).size;

    expect(world.update(0, 0, sink)).toBe(expected);
    expect(world.pendingCount).toBe(expected);
    drainAll(world, sink);

    expect(sink.loaded.length).toBe(expected);
    expect(sink.unloaded.length).toBe(0);
    expect(world.loadedCount).toBe(expected);
    expect(sink.totalVertices).toBeGreaterThan(0);

    // Moving within the same chunk column must not touch the loaded set at
    // all -- this early-out is why update() can be called every frame.
    expect(world.update(1.0, 1.0, sink)).toBe(0);
  });

  it("stops uploading once the time budget is spent, but always makes progress", () => {
    // The budget is the whole reason workers do not merely relocate the
    // stall: results arrive far faster than the main thread can upload
    // them, so something has to decide when to stop for this frame.
    const world = makeWorld();
    const sink = new RecordingSink();
    const submitted = world.update(0, 0, sink);

    // A zero budget must still upload exactly one chunk -- otherwise a
    // slow frame would stop the stream permanently instead of slowing it.
    world.drain(sink, 0);
    expect(sink.loaded.length).toBe(1);
    expect(world.pendingCount).toBe(submitted - 1);

    world.drain(sink, 0);
    expect(sink.loaded.length).toBe(2);

    // And an unlimited budget must clear the rest in one go.
    world.drain(sink, Number.POSITIVE_INFINITY);
    expect(sink.loaded.length).toBe(submitted);
  });

  it("loads and unloads only the crescent when crossing one boundary", () => {
    const world = makeWorld();
    const sink = new RecordingSink();
    world.update(0, 0, sink);
    drainAll(world, sink);
    const afterInitial = world.loadedCount;

    sink.reset();
    const submitted = world.update(CHUNK_METERS * 1.5, 0, sink);
    drainAll(world, sink);

    expect(submitted).toBeGreaterThan(0);
    // The set is the same shape translated by one chunk, so what comes in
    // and what goes out must balance exactly.
    expect(sink.loaded.length).toBe(sink.unloaded.length);
    expect(sink.loaded.length).toBeLessThan(afterInitial / 2);
    expect(world.loadedCount).toBe(afterInitial);
    // A chunk must never be unloaded and reloaded in the same pass -- that
    // would mean regenerating terrain that was already in memory.
    for (const key of sink.unloaded) expect(sink.loaded).not.toContain(key);
  });

  it("discards results for chunks the player moved away from", () => {
    // Submit a long way from where we end up, then drain. Every result is
    // stale and must be dropped rather than uploaded.
    const world = makeWorld(1);
    const sink = new RecordingSink();
    world.update(0, 0, sink);
    world.update(CHUNK_METERS * 500, 0, sink);
    drainAll(world, sink);

    const desired = desiredChunkSet(500, 0, 1, new Set());
    for (const key of sink.loaded) expect(desired.has(key)).toBe(true);
    expect(world.loadedCount).toBe(desired.size);
  });

  it("answers solid and ground height from the loaded tiles, and empty outside them", () => {
    const world = makeWorld();
    const sink = new RecordingSink();
    world.update(0, 0, sink);
    drainAll(world, sink);

    const ground = world.groundHeight(0.05, 0.05);
    const surfaceY = Math.floor(ground / VOXEL_SIZE);
    expect(world.isSolid(0, surfaceY - 8, 0)).toBe(true);
    expect(world.isSolid(0, surfaceY + 8, 0)).toBe(false);
    expect(world.isSolid(100000, surfaceY - 8, 100000)).toBe(false);
    expect(world.hasChunkAt(0, 0, 0)).toBe(true);
    expect(world.hasChunkAt(100000, 0, 100000)).toBe(false);
  });

  it("gives the same ground height from a loaded tile as straight from the generator", () => {
    const loaded = makeWorld();
    const unloaded = makeWorld();
    const sink = new RecordingSink();
    loaded.update(0, 0, sink);
    drainAll(loaded, sink);
    for (const [x, z] of [[0.3, 0.7], [-1.9, 2.2], [2.5, -3.1], [5.55, 5.55]] as const) {
      expect(loaded.groundHeight(x, z)).toBeCloseTo(unloaded.groundHeight(x, z), 5);
    }
  });
});
