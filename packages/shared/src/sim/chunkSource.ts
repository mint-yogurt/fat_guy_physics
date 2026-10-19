import type { ChunkKey } from "./chunkKey.ts";
import { FLOATS_PER_VERTEX } from "../voxel/vertexLayout.ts";
import { Mesher } from "../voxel/greedyMesher.ts";
import { createChunkGrid } from "../voxel/voxelGrid.ts";
import { TerrainGenerator } from "../worldgen/terrainGenerator.ts";

/**
 * Where generated chunks come from.
 *
 * This is the seam the C++ puts behind a thread pool (World::submitJob /
 * workerLoop / drainCompleted). Here it is an interface because the two
 * implementations live on opposite sides of the client/server split: the
 * browser runs {@link WorkerChunkSource} over real Web Workers, while tests
 * and the authoritative server use {@link SyncChunkSource}, which has no
 * concurrency at all.
 *
 * Results are polled rather than pushed. A callback would have to fire
 * whenever a worker happened to finish, which is mid-frame -- so uploads
 * would land at an arbitrary point in the frame and could not be budgeted.
 * Polling keeps the "how much GPU work this frame" decision in one place.
 */

/** One finished chunk. Every buffer is owned by the receiver. */
export interface ChunkResult {
  key: ChunkKey;
  cx: number;
  cy: number;
  cz: number;
  /** CHUNK_VOLUME material bytes. */
  cells: Uint8Array;
  /** Exactly `vertexCount * FLOATS_PER_VERTEX` long -- no slack. */
  vertices: Float32Array;
  vertexCount: number;
}

export interface ChunkSource {
  /** Queues a chunk. Never called twice for the same key while in flight. */
  submit(key: ChunkKey, cx: number, cy: number, cz: number): void;
  /** The next finished chunk, or undefined if none are ready. */
  poll(): ChunkResult | undefined;
  /** How many chunks are queued or being worked on. */
  readonly pending: number;
  dispose(): void;
}

/**
 * Generates and meshes one chunk. Pure CPU work with no I/O and no shared
 * state beyond the generator's seed, which is what makes it safe to run on a
 * worker.
 *
 * The returned vertex array is a **copy** sized exactly to the vertex count,
 * not a view onto the mesher's scratch. That is deliberate: this value
 * crosses a thread boundary as a transferable, so it has to own its buffer,
 * and a transferable has to be exactly the right size or the receiver pays
 * for the slack forever.
 */
export function buildChunk(
  generator: TerrainGenerator,
  mesher: Mesher,
  key: ChunkKey,
  cx: number,
  cy: number,
  cz: number,
): ChunkResult {
  const grid = createChunkGrid();
  generator.generate(grid, cx, cy, cz);
  const mesh = mesher.mesh(grid);
  return {
    key,
    cx,
    cy,
    cz,
    cells: grid.cells,
    vertices: mesh.vertices.slice(0, mesh.vertexCount * FLOATS_PER_VERTEX),
    vertexCount: mesh.vertexCount,
  };
}

/**
 * Generates on submit, on the calling thread.
 *
 * Used by tests and by the server, where there is no frame to protect. In
 * the browser this is what M2 effectively did, and why the initial load
 * froze the tab.
 */
export class SyncChunkSource implements ChunkSource {
  private readonly generator: TerrainGenerator;
  private readonly mesher = new Mesher();
  private readonly ready: ChunkResult[] = [];

  constructor(seed: number) {
    this.generator = new TerrainGenerator(seed);
  }

  get pending(): number {
    return this.ready.length;
  }

  submit(key: ChunkKey, cx: number, cy: number, cz: number): void {
    this.ready.push(buildChunk(this.generator, this.mesher, key, cx, cy, cz));
  }

  poll(): ChunkResult | undefined {
    return this.ready.shift();
  }

  dispose(): void {
    this.ready.length = 0;
  }
}
