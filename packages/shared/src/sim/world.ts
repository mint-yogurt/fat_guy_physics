import { chunkKey, keyX, keyY, keyZ, type ChunkKey } from "./chunkKey.ts";
import type { ChunkResult, ChunkSource } from "./chunkSource.ts";
import { CHUNK_SIZE, VOXEL_SIZE } from "./constants.ts";
import { nowMs } from "./time.ts";
import { floorDiv, floorMod, isSolid, Material } from "../voxel/voxel.ts";
import { gridIndex, type VoxelGrid } from "../voxel/voxelGrid.ts";
import { TerrainGenerator } from "../worldgen/terrainGenerator.ts";

/**
 * Chunk streaming and voxel storage. Ports the data half of
 * src/voxel/World.{hpp,cpp}.
 *
 * Two things from the C++ are deliberately absent:
 *
 *  - **All rendering.** The C++ World owns ChunkMesh (GL) objects and has a
 *    draw() method. Here, meshes are handed to a {@link ChunkSink} and the
 *    client owns them, because this module also has to run on the
 *    authoritative server, which has no GPU and does not mesh anything.
 *  - **The thread pool itself.** Concurrency lives behind {@link ChunkSource}
 *    instead, so the same World drives real Web Workers in the browser and
 *    plain synchronous generation on the server and in tests.
 *
 * Vertical range is a fixed band rather than streamed, same reasoning as the
 * C++: the heightmap generator only produces terrain in a known bounded Y
 * range, so there is nothing above or below it to stream. That stops being
 * true once caves or full 3D density generation exist (M13).
 */

/** Matches the C++ kVerticalChunkMin/kVerticalChunkMax. */
export const VERTICAL_CHUNK_MIN = 0;
export const VERTICAL_CHUNK_MAX = 3;

export const DEFAULT_LOAD_RADIUS_CHUNKS = 6;

/** Chunk edge length in metres. */
export const CHUNK_METERS = CHUNK_SIZE * VOXEL_SIZE;

/**
 * Main-thread milliseconds a single drain may spend turning finished chunks
 * into GPU geometry.
 *
 * Workers finish far faster than the main thread can upload, so without a
 * cap a burst of completions -- the initial load, or sprinting across
 * several boundaries at once -- would dump every upload into one frame and
 * reproduce exactly the stall the workers were added to remove. Leftovers
 * wait for the next frame.
 *
 * The C++ budgets a fixed *count* (kMaxMeshUploadsPerFrame = 4) instead.
 * A time budget is used here because the quantity actually being protected
 * is frame time, and per-chunk upload cost varies by an order of magnitude
 * with vertex count -- four dense chunks and four nearly-empty ones are not
 * remotely the same amount of work. Four milliseconds leaves most of a
 * 60Hz frame for rendering while clearing a full-radius initial load in
 * about a second.
 */
export const MAX_DRAIN_MS = 4;

/**
 * Receives chunk lifecycle events. The client implements this to create and
 * destroy GPU geometry; the server will not implement it at all.
 */
export interface ChunkSink {
  /**
   * The result's buffers are handed over -- the sink owns them, and World
   * keeps no reference to `vertices`.
   */
  onChunkLoaded(result: ChunkResult): void;
  onChunkUnloaded(key: ChunkKey): void;
}

/**
 * Fills `out` with the chunks a center column wants loaded.
 *
 * Extracted from update() as its own function for two reasons: it is the
 * single place the load *shape* is decided, so switching from "cylinder of a
 * fixed Y band" to real vertical streaming is a change to one function; and
 * it is the only part of streaming that is pure enough to unit-test
 * directly.
 *
 * The radius test is `dx*dx + dz*dz > r*r` on chunk indices, matching the
 * C++ exactly -- note this makes the region a cylinder centred on the
 * *chunk* the camera is in, not on the camera, so the loaded radius wobbles
 * by up to a chunk as the player moves. That is existing behaviour and is
 * kept on purpose.
 */
export function desiredChunkSet(
  centerX: number,
  centerZ: number,
  radiusChunks: number,
  out: Set<ChunkKey>,
): Set<ChunkKey> {
  out.clear();
  const radiusSq = radiusChunks * radiusChunks;
  for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
    for (let dz = -radiusChunks; dz <= radiusChunks; dz++) {
      if (dx * dx + dz * dz > radiusSq) continue;
      for (let cy = VERTICAL_CHUNK_MIN; cy <= VERTICAL_CHUNK_MAX; cy++) {
        out.add(chunkKey(centerX + dx, cy, centerZ + dz));
      }
    }
  }
  return out;
}

export class World {
  private readonly generator: TerrainGenerator;
  private readonly chunks = new Map<ChunkKey, VoxelGrid>();
  private readonly desired = new Set<ChunkKey>();
  private readonly inFlight = new Set<ChunkKey>();

  /** Scratch for the distance sort in submitDesired. Reused, never freed. */
  private readonly submitQueue: ChunkKey[] = [];

  private hasCenter = false;
  private centerX = 0;
  private centerZ = 0;

  constructor(
    readonly seed: number,
    private readonly source: ChunkSource,
    private readonly loadRadiusChunks = DEFAULT_LOAD_RADIUS_CHUNKS,
  ) {
    this.generator = new TerrainGenerator(seed);
  }

  get loadedCount(): number {
    return this.chunks.size;
  }

  /** Chunks submitted but not yet drained. Zero means streaming has settled. */
  get pendingCount(): number {
    return this.inFlight.size;
  }

  get radius(): number {
    return this.loadRadiusChunks;
  }

  surfaceHeightVoxels(worldX: number, worldZ: number): number {
    return this.generator.surfaceHeight(worldX, worldZ);
  }

  /**
   * Recomputes the desired set around a world-space position, unloading what
   * fell out of range and submitting what came into it. Returns the number
   * of chunks submitted.
   *
   * Allocation-free and near-instant on the overwhelming majority of frames:
   * it early-returns unless the camera actually changed chunk column.
   */
  update(worldX: number, worldZ: number, sink: ChunkSink): number {
    const centerX = Math.floor(worldX / CHUNK_METERS);
    const centerZ = Math.floor(worldZ / CHUNK_METERS);
    if (this.hasCenter && centerX === this.centerX && centerZ === this.centerZ) {
      return 0;
    }
    this.hasCenter = true;
    this.centerX = centerX;
    this.centerZ = centerZ;

    desiredChunkSet(centerX, centerZ, this.loadRadiusChunks, this.desired);

    for (const key of this.chunks.keys()) {
      if (this.desired.has(key)) continue;
      this.chunks.delete(key);
      sink.onChunkUnloaded(key);
    }

    return this.submitDesired(centerX, centerZ);
  }

  private submitDesired(centerX: number, centerZ: number): number {
    const queue = this.submitQueue;
    queue.length = 0;
    for (const key of this.desired) {
      if (this.chunks.has(key) || this.inFlight.has(key)) continue;
      queue.push(key);
    }

    // Nearest-first, so the ground the player is standing on appears before
    // the horizon does. Without this the pop-in order is whatever the Set
    // happens to iterate in, which on the initial load means staring at
    // distant chunks while the terrain underfoot is still missing.
    queue.sort((a, b) => {
      const ax = keyX(a) - centerX;
      const az = keyZ(a) - centerZ;
      const bx = keyX(b) - centerX;
      const bz = keyZ(b) - centerZ;
      return ax * ax + az * az - (bx * bx + bz * bz);
    });

    for (const key of queue) {
      this.inFlight.add(key);
      this.source.submit(key, keyX(key), keyY(key), keyZ(key));
    }
    return queue.length;
  }

  /**
   * Hands finished chunks to the sink for up to `budgetMs` of main-thread
   * time.
   *
   * Must run every frame, not just on boundary crossings -- otherwise
   * finished chunks sit in the queue until the next crossing happens to
   * occur and the world looks like it stopped streaming. The C++ makes the
   * same point at the top of World::update.
   *
   * Always uploads at least one chunk when one is ready, so that a budget
   * smaller than a single upload still makes forward progress rather than
   * deadlocking the stream.
   *
   * Returns milliseconds spent, which is the number worth watching: it is
   * main-thread time, and it is the only part of streaming the workers did
   * not take away.
   */
  drain(sink: ChunkSink, budgetMs = MAX_DRAIN_MS): number {
    const started = nowMs();
    let uploaded = 0;
    for (;;) {
      if (uploaded > 0 && nowMs() - started >= budgetMs) break;

      const result = this.source.poll();
      if (result === undefined) break;
      this.inFlight.delete(result.key);

      if (!this.desired.has(result.key)) {
        // The player moved away before this finished. Dropping it is
        // cheaper than uploading terrain nobody can see, and it costs
        // nothing against the budget because no GPU work happened.
        continue;
      }

      this.chunks.set(result.key, {
        dimX: CHUNK_SIZE,
        dimY: CHUNK_SIZE,
        dimZ: CHUNK_SIZE,
        originX: 0,
        originY: 0,
        originZ: 0,
        cells: result.cells,
      });
      sink.onChunkLoaded(result);
      uploaded++;
    }
    return uploaded === 0 ? 0 : nowMs() - started;
  }

  /** Air for voxels in unloaded chunks, not just voxels that are actually Air. */
  materialAt(worldVoxelX: number, worldVoxelY: number, worldVoxelZ: number): Material {
    const grid = this.chunks.get(
      chunkKey(
        floorDiv(worldVoxelX, CHUNK_SIZE),
        floorDiv(worldVoxelY, CHUNK_SIZE),
        floorDiv(worldVoxelZ, CHUNK_SIZE),
      ),
    );
    if (grid === undefined) return Material.Air;
    return grid.cells[
      gridIndex(
        grid,
        floorMod(worldVoxelX, CHUNK_SIZE),
        floorMod(worldVoxelY, CHUNK_SIZE),
        floorMod(worldVoxelZ, CHUNK_SIZE),
      )
    ] as Material;
  }

  /** Whether the chunk containing a world-space point is loaded. */
  hasChunkAt(worldX: number, worldY: number, worldZ: number): boolean {
    return this.chunks.has(
      chunkKey(
        Math.floor(worldX / CHUNK_METERS),
        Math.floor(worldY / CHUNK_METERS),
        Math.floor(worldZ / CHUNK_METERS),
      ),
    );
  }

  /**
   * {@link SolidQuery} for the collision code. Terrain only: felled logs
   * and other oriented rigid bodies join this at M8, via a composite query
   * rather than by being special-cased in here (see the stopgap comment on
   * the C++ World::isSolidIncludingSnappedLogs).
   */
  isSolid(vx: number, vy: number, vz: number): boolean {
    return isSolid(this.materialAt(vx, vy, vz));
  }

  dispose(): void {
    this.source.dispose();
  }
}
