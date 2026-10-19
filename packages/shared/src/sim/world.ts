import { chunkKey, keyX, keyY, keyZ, type ChunkKey } from "./chunkKey.ts";
import { CHUNK_SIZE, VOXEL_SIZE } from "./constants.ts";
import { nowMs } from "./time.ts";
import { Mesher, type MeshData } from "../voxel/greedyMesher.ts";
import { floorDiv, floorMod, Material } from "../voxel/voxel.ts";
import { createChunkGrid, gridIndex, type VoxelGrid } from "../voxel/voxelGrid.ts";
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
 *  - **All threading.** The C++ World is a worker pool. At M2 every load is
 *    synchronous on the calling thread, which means crossing a chunk
 *    boundary visibly hitches. That is the motivation for M3, not an
 *    oversight; the split that makes M3 easy is already here, since
 *    {@link loadChunk} is pure CPU work with no sink interaction.
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
 * Receives chunk lifecycle events. The client implements this to create and
 * destroy GPU geometry; the server will not implement it at all.
 */
export interface ChunkSink {
  /**
   * `mesh` is a **view onto the mesher's reusable scratch buffer** and is
   * invalidated by the next chunk load. Copy anything you need to keep. (At
   * M3 the buffer arrives from a worker as a transferable and this caveat
   * goes away.)
   */
  onChunkLoaded(key: ChunkKey, cx: number, cy: number, cz: number, mesh: MeshData): void;
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

/** What one {@link World.update} call did, for the HUD and for tests. */
export interface StreamStats {
  loaded: number;
  unloaded: number;
  /** Wall-clock milliseconds spent generating and meshing. */
  ms: number;
}

export class World {
  private readonly generator: TerrainGenerator;
  private readonly mesher = new Mesher();
  private readonly chunks = new Map<ChunkKey, VoxelGrid>();
  private readonly desired = new Set<ChunkKey>();
  private readonly stats: StreamStats = { loaded: 0, unloaded: 0, ms: 0 };

  private hasCenter = false;
  private centerX = 0;
  private centerZ = 0;

  constructor(
    readonly seed: number,
    private readonly loadRadiusChunks = DEFAULT_LOAD_RADIUS_CHUNKS,
  ) {
    this.generator = new TerrainGenerator(seed);
  }

  get loadedCount(): number {
    return this.chunks.size;
  }

  get radius(): number {
    return this.loadRadiusChunks;
  }

  surfaceHeightVoxels(worldX: number, worldZ: number): number {
    return this.generator.surfaceHeight(worldX, worldZ);
  }

  /**
   * Streams around a world-space position. Cheap and allocation-free on the
   * overwhelming majority of frames: it early-returns unless the camera
   * actually changed chunk column.
   */
  update(worldX: number, worldZ: number, sink: ChunkSink): StreamStats {
    const stats = this.stats;
    stats.loaded = 0;
    stats.unloaded = 0;
    stats.ms = 0;

    const centerX = Math.floor(worldX / CHUNK_METERS);
    const centerZ = Math.floor(worldZ / CHUNK_METERS);
    if (this.hasCenter && centerX === this.centerX && centerZ === this.centerZ) {
      return stats;
    }
    this.hasCenter = true;
    this.centerX = centerX;
    this.centerZ = centerZ;

    desiredChunkSet(centerX, centerZ, this.loadRadiusChunks, this.desired);

    const started = nowMs();

    for (const key of this.chunks.keys()) {
      if (this.desired.has(key)) continue;
      this.chunks.delete(key);
      sink.onChunkUnloaded(key);
      stats.unloaded++;
    }

    for (const key of this.desired) {
      if (this.chunks.has(key)) continue;
      const cx = keyX(key);
      const cy = keyY(key);
      const cz = keyZ(key);
      const mesh = this.loadChunk(key, cx, cy, cz);
      sink.onChunkLoaded(key, cx, cy, cz, mesh);
      stats.loaded++;
    }

    stats.ms = nowMs() - started;
    return stats;
  }

  /**
   * Generates and meshes one chunk, inserting the grid into the loaded set.
   * Pure CPU work -- no sink, no GPU -- which is exactly the boundary a
   * worker runs behind at M3.
   */
  private loadChunk(key: ChunkKey, cx: number, cy: number, cz: number): MeshData {
    const grid = createChunkGrid();
    this.generator.generate(grid, cx, cy, cz);
    this.chunks.set(key, grid);
    return this.mesher.mesh(grid);
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
}
