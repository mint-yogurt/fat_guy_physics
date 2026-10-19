import { describe, expect, it } from "vitest";

import { chunkKey, keyX, keyY, keyZ } from "./chunkKey.ts";
import type { MeshData } from "../voxel/greedyMesher.ts";
import { Material } from "../voxel/voxel.ts";
import {
  CHUNK_METERS,
  type ChunkSink,
  desiredChunkSet,
  VERTICAL_CHUNK_MAX,
  VERTICAL_CHUNK_MIN,
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
  const layers = VERTICAL_CHUNK_MAX - VERTICAL_CHUNK_MIN + 1;

  function columnsForRadius(radius: number): number {
    let columns = 0;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx * dx + dz * dz <= radius * radius) columns++;
      }
    }
    return columns;
  }

  it("fills a cylinder of the fixed vertical band", () => {
    const out = desiredChunkSet(0, 0, 6, new Set());
    expect(out.size).toBe(columnsForRadius(6) * layers);

    for (const key of out) {
      const y = keyY(key);
      expect(y).toBeGreaterThanOrEqual(VERTICAL_CHUNK_MIN);
      expect(y).toBeLessThanOrEqual(VERTICAL_CHUNK_MAX);
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
    /** Sum of vertexCount, to prove the mesh handed over is real data. */
    totalVertices = 0;

    onChunkLoaded(key: number, _cx: number, _cy: number, _cz: number, mesh: MeshData): void {
      this.loaded.push(key);
      this.totalVertices += mesh.vertexCount;
    }
    onChunkUnloaded(key: number): void {
      this.unloaded.push(key);
    }
  }

  const RADIUS = 2;

  it("loads the full cylinder on the first update and nothing on the second", () => {
    const world = new World(1337, RADIUS);
    const sink = new RecordingSink();

    const first = world.update(0, 0, sink);
    expect(first.loaded).toBe(desiredChunkSet(0, 0, RADIUS, new Set()).size);
    expect(first.unloaded).toBe(0);
    expect(world.loadedCount).toBe(first.loaded);
    expect(sink.totalVertices).toBeGreaterThan(0);

    // Moving within the same chunk column must not touch the loaded set at
    // all -- this early-out is why update() can be called every frame.
    const second = world.update(1.0, 1.0, sink);
    expect(second.loaded).toBe(0);
    expect(second.unloaded).toBe(0);
  });

  it("loads and unloads only the crescent when crossing one boundary", () => {
    const world = new World(1337, RADIUS);
    const sink = new RecordingSink();
    world.update(0, 0, sink);
    const afterInitial = world.loadedCount;

    sink.loaded.length = 0;
    sink.unloaded.length = 0;
    const crossed = world.update(CHUNK_METERS * 1.5, 0, sink);

    expect(crossed.loaded).toBeGreaterThan(0);
    // The set is the same shape translated by one chunk, so what comes in
    // and what goes out must balance exactly.
    expect(crossed.loaded).toBe(crossed.unloaded);
    expect(crossed.loaded).toBeLessThan(afterInitial / 2);
    expect(world.loadedCount).toBe(afterInitial);
    expect(sink.loaded.length).toBe(crossed.loaded);
    expect(sink.unloaded.length).toBe(crossed.unloaded);
    // An unloaded chunk must never also be reported as loaded in the same
    // pass -- that would mean a chunk was needlessly regenerated.
    for (const key of sink.unloaded) expect(sink.loaded).not.toContain(key);
  });

  it("reads voxels back through materialAt and returns Air outside the loaded set", () => {
    const world = new World(1337, RADIUS);
    world.update(0, 0, new RecordingSink());

    // Deep underground inside the loaded band is solid; far outside the
    // radius is Air because the chunk simply is not there.
    const surfaceY = world.surfaceHeightVoxels(0, 0);
    expect(world.materialAt(0, surfaceY - 8, 0)).not.toBe(Material.Air);
    expect(world.materialAt(0, surfaceY + 8, 0)).toBe(Material.Air);
    expect(world.materialAt(100000, surfaceY - 8, 100000)).toBe(Material.Air);
  });
});
