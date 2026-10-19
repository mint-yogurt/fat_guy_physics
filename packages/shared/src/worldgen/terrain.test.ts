import { describe, expect, it } from "vitest";

import golden from "../../../../tools/golden/golden.json" with { type: "json" };
import { Mesher } from "../voxel/greedyMesher.ts";
import { FLOATS_PER_VERTEX } from "../voxel/vertexLayout.ts";
import { createChunkGrid } from "../voxel/voxelGrid.ts";
import { TerrainGenerator } from "./terrainGenerator.ts";

/**
 * Golden-data comparison against the C++ reference build for terrain
 * generation and greedy meshing.
 *
 * Generation and meshing are checked separately -- the dump carries a voxel
 * digest alongside the mesh -- so a failure says which of the two is wrong
 * instead of conflating them.
 */

/** Order-sensitive FNV-1a over the voxel array, matching the C++ dumper. */
function voxelDigest(cells: Uint8Array, chunkSize: number): number {
  let h = 2166136261 >>> 0;
  for (let z = 0; z < chunkSize; ++z) {
    for (let y = 0; y < chunkSize; ++y) {
      for (let x = 0; x < chunkSize; ++x) {
        h = (h ^ (cells[x + chunkSize * (y + chunkSize * z)] as number)) >>> 0;
        h = Math.imul(h, 16777619) >>> 0;
      }
    }
  }
  return h >>> 0;
}

describe("TerrainGenerator", () => {
  const gen = new TerrainGenerator(golden.seed);

  it("matches the C++ surface height, including at negative coordinates", () => {
    const mismatches: string[] = [];
    for (const { x, z, h } of golden.surfaceHeight) {
      const actual = gen.surfaceHeight(x, z);
      if (actual !== h) mismatches.push(`surfaceHeight(${x}, ${z}) = ${actual}, expected ${h}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("produces the C++ voxel contents for every golden chunk", () => {
    const grid = createChunkGrid();
    for (const chunk of golden.chunks) {
      const [cx, cy, cz] = chunk.coord as [number, number, number];
      grid.cells.fill(0);
      gen.generate(grid, cx, cy, cz);
      expect(voxelDigest(grid.cells, golden.chunkSize), `chunk ${cx},${cy},${cz}`).toBe(
        chunk.voxelDigest,
      );
    }
  });
});

describe("greedy mesher", () => {
  const gen = new TerrainGenerator(golden.seed);

  it("covers the structurally distinct cases", () => {
    // Guards the fixture itself: an earlier revision picked chunk coords
    // that all turned out to be above the terrain, so three of them asserted
    // nothing while still passing.
    const counts = golden.chunks.map((c) => c.vertexCount);
    expect(counts.filter((n) => n === 0).length).toBe(1); // the deliberate air chunk
    expect(counts.filter((n) => n > 1000).length).toBeGreaterThanOrEqual(4);
  });

  it("emits the C++ vertex buffer for every golden chunk", () => {
    const grid = createChunkGrid();
    const mesher = new Mesher();

    for (const chunk of golden.chunks) {
      const [cx, cy, cz] = chunk.coord as [number, number, number];
      const label = `chunk ${cx},${cy},${cz}`;

      grid.cells.fill(0);
      gen.generate(grid, cx, cy, cz);
      const mesh = mesher.mesh(grid);

      // Checked first and exactly: a vertex-count difference means the
      // greedy quad merging itself diverged, which is a structural bug, not
      // a float one, and every per-float diff after it would be noise.
      expect(mesh.vertexCount, `${label} vertex count`).toBe(chunk.vertexCount);

      const expected = chunk.vertices as number[];
      expect(expected.length).toBe(chunk.vertexCount * FLOATS_PER_VERTEX);

      // Epsilon rather than exact: the C++ computes in float32 and this
      // computes in float64 before storing to a Float32Array, so the two can
      // differ in the last bit. 1e-6 is far below any geometrically
      // meaningful difference while still catching a wrong tint, a swapped
      // axis, or a mis-wound quad -- all of which are 1e-1-scale errors.
      let firstMismatch = "";
      for (let i = 0; i < expected.length; ++i) {
        const a = mesh.vertices[i] as number;
        const b = expected[i] as number;
        if (Math.abs(a - b) > 1e-6) {
          const vertex = Math.floor(i / FLOATS_PER_VERTEX);
          const field = i % FLOATS_PER_VERTEX;
          firstMismatch = `${label}: vertex ${vertex} field ${field}: got ${a}, expected ${b}`;
          break;
        }
      }
      expect(firstMismatch).toBe("");
    }
  });

  it("reuses its scratch buffers across meshes", () => {
    // The Mesher's whole reason for being a class is that a worker holds one
    // and it stops allocating. If mesh() ever starts handing back freshly
    // allocated storage this silently regresses, so pin the behaviour: the
    // second mesh must be a view onto the same backing store as the first.
    const grid = createChunkGrid();
    const mesher = new Mesher();

    gen.generate(grid, 0, 2, 0);
    const first = mesher.mesh(grid);
    const firstBuffer = first.vertices.buffer;

    gen.generate(grid, 0, 2, 1);
    const second = mesher.mesh(grid);

    expect(second.vertices.buffer).toBe(firstBuffer);
  });
});
