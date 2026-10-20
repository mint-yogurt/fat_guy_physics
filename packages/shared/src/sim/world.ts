import { chunkKey, keyX, keyY, keyZ, type ChunkKey } from "./chunkKey.ts";
import type { ChunkResult, ChunkSource } from "./chunkSource.ts";
import { CHUNK_SIZE, VOXEL_SIZE } from "./constants.ts";
import { nowMs } from "./time.ts";
import { Mesher, type MeshData } from "../voxel/greedyMesher.ts";
import { floorDiv, floorMod, isHandDiggable, isSolid, Material } from "../voxel/voxel.ts";
import { gridIndex, type VoxelGrid } from "../voxel/voxelGrid.ts";
import { createVoxelHit, raycastVoxel } from "../voxel/voxelRaycast.ts";
import type { Biome } from "../voxel/biomeTint.ts";
import type { BiomeWeights } from "../worldgen/biome.ts";
import { DROP_CHANCE, OBJECT_SHEET } from "../worldgen/generationSheet.ts";
import { PROP_METRICS, type PropKind } from "../worldgen/props.ts";
import { placeVegetation, type Placement } from "../worldgen/spawns.ts";
import { TerrainGenerator } from "../worldgen/terrainGenerator.ts";
import { metricsFor, treeShape } from "../worldgen/trees.ts";
import type { TreeSpecies } from "../worldgen/trees.ts";

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

/**
 * The C++ had 0..3 (12.8 m), enough for its +/-2.4 m bumps. Cliffs and
 * tiered bluffs reach 6.4 m base + ~9 m, so one more layer: 0..4 is 16 m.
 * The extra layer is mostly air and meshes to nothing, but it is a fifth of
 * the chunks generated and tested for, which is why it is not simply 8.
 */
export const VERTICAL_CHUNK_MIN = 0;
export const VERTICAL_CHUNK_MAX = 4;

/**
 * Doubled from the C++'s 6 at M13. Six chunks is 19m, which is close enough
 * that terrain visibly pops into existence in front of the player; 12 is 38m,
 * far enough that the atmosphere's distance fade hides the boundary. Costs
 * ~4x the loaded chunks, which the worker pool absorbs because generation was
 * never the bottleneck -- main-thread upload is, and that is budgeted.
 */
export const DEFAULT_LOAD_RADIUS_CHUNKS = 12;

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
  /**
   * An already-loaded chunk's geometry changed (digging).
   *
   * Unlike onChunkLoaded, `vertices` is a **view onto reusable scratch** and
   * is invalidated by the next remesh -- edits happen on the main thread
   * against a shared mesher, so there is no transferable to hand over. Copy
   * what you keep.
   */
  onChunkRemeshed(
    key: ChunkKey,
    cx: number,
    cy: number,
    cz: number,
    vertices: Float32Array,
    vertexCount: number,
  ): void;
  /**
   * A tree came into range. The sink builds its scene objects from the
   * tree's species and dimensions; no geometry is passed, because a tree is
   * an authored mesh and every tree of a species shares it.
   */
  onTreePlaced(tree: Tree): void;
  onTreeUnloaded(treeId: number): void;
  /**
   * A prop came into range: a snowman, a present, a tombstone, a grave. Like
   * a tree it is an authored mesh shared by every prop of its kind.
   */
  onPropPlaced(prop: Prop): void;
  onPropUnloaded(propId: number): void;
  /** One foliage cluster was knocked off. The tree keeps standing. */
  onTreeFoliageRemoved(tree: Tree, cluster: number): void;
  /**
   * A scattered plant. These are billboards, not voxel objects: they are
   * decorative, there are a lot of them, and nothing interacts with them.
   */
  onBushPlaced(id: number, x: number, y: number, z: number, sizeMeters: number): void;
  /**
   * A chop cut through the trunk. The tree has already been shortened to
   * `cutHeightMeters` above its base, and the piece above that -- a length
   * of trunk plus whichever foliage clusters `carriedFoliage` has bits for
   * -- is the sink's to drop as a rigid body.
   *
   * The sink does the geometry: it owns the authored mesh, so it is the
   * only side that can slice the trunk at the cut.
   */
  onTreeCut(
    tree: Tree,
    cutHeightMeters: number,
    pieceLengthMeters: number,
    carriedFoliage: number,
  ): void;
}

/**
 * A standing tree: an authored mesh placed in the world, plus the simple
 * shapes that stand in for it when something has to be aimed at or cut.
 *
 * Trees are objects with identity rather than terrain voxels, because a
 * tree gets chopped, remembers having been chopped, and hands its top half
 * to the rigid-body layer. A chunk edit has none of those.
 *
 * Everything here is world metres rather than voxels: the mesh is
 * continuous, so there is nothing left that wants the voxel lattice.
 */
export interface Tree {
  /** Placement hash. Stable across streaming, so edits can persist. */
  readonly id: number;
  readonly species: TreeSpecies;
  /** The region that placed it: a Halloween broadleaf is drawn in autumn colours. */
  readonly biome: Biome;
  /** Centre of the trunk's base. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Authored units to metres, and the yaw the mesh is planted at. */
  readonly scale: number;
  readonly yaw: number;
  readonly heightMeters: number;
  readonly trunkRadiusMeters: number;
  /** Top of the standing trunk, metres above the base. A chop lowers it. */
  trunkTopMeters: number;
  /** Which foliage clusters are still attached, one bit each. */
  foliageMask: number;
  severed: boolean;
  /**
   * Chop progress: the cut height being worked on, and how many swings have
   * landed on it. A trunk takes several swings, and moving the cut more
   * than CHOP_REANCHOR_METERS starts a fresh one -- otherwise nibbling at
   * three heights would fell a tree as fast as three clean swings at one.
   */
  chopHeightMeters: number;
  chopHits: number;
}

/**
 * A placed prop. Decoration, a container, or a source of resources, and not
 * (yet) solid to the player -- only the aiming raycast sees it, through the
 * cylinder `radius` x `height`.
 */
export interface Prop {
  readonly id: number;
  readonly kind: PropKind;
  readonly biome: Biome;
  /** Where its base sits on the ground. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly yaw: number;
  /** Lean about its own X and Z, radians; at most one is non-zero. */
  readonly tiltX: number;
  readonly tiltZ: number;
  /** Graves: covered, or open. */
  readonly topsoil: boolean;
  /** Item names inside, for a container. */
  readonly loot: readonly string[];
  /** Aiming cylinder, metres. Zero height means it cannot be aimed at. */
  readonly radius: number;
  readonly height: number;
}

/** Swings to cut through a trunk, and how far a cut may wander. */
const CHOPS_TO_FELL = 3;
const CHOP_REANCHOR_METERS = 0.4;
/** The shortest stump left standing, and the shortest piece worth dropping. */
const MIN_STUMP_METERS = 0.3;
const MIN_PIECE_METERS = 0.4;

export const HitKind = {
  None: 0,
  Terrain: 1,
  Tree: 2,
  Prop: 3,
} as const;
export type HitKind = (typeof HitKind)[keyof typeof HitKind];

/**
 * What the crosshair is on.
 *
 * Flat, and always resolves to *something* in range -- the C++ returns a
 * `std::variant` that enumerates only what happens to be hittable today,
 * which its own comments flag as a design dead end (every new hittable
 * thing is a new variant arm and a new `std::get_if` at every call site).
 * A kind tag plus the world-space centre of the hit voxel is all any
 * caller has ever actually wanted.
 */
export const TREE_PART_TRUNK = -1;

/** What one chup swing did. */
export interface ChopResult {
  /** The swing hit the trunk at all. Drives the item drops. */
  readonly landed: boolean;
  /** This swing cut through, so a piece is on its way down. */
  readonly felled: boolean;
}

const NO_CHOP: ChopResult = { landed: false, felled: false };

export interface SceneHit {
  kind: HitKind;
  /** Valid when kind is Tree. */
  treeId: number;
  /** Valid when kind is Prop. */
  propId: number;
  /**
   * Which part of that tree: TREE_PART_TRUNK, or a foliage cluster index.
   * The trunk is chopped and the clusters are harvested, so the two are
   * never interchangeable at a call site.
   */
  treePart: number;
  voxelX: number;
  voxelY: number;
  voxelZ: number;
  /** World-space centre of the hit voxel, which is what the edits take. */
  centerX: number;
  centerY: number;
  centerZ: number;
  distance: number;
}

export function createSceneHit(): SceneHit {
  return {
    kind: HitKind.None,
    treeId: 0,
    propId: 0,
    treePart: TREE_PART_TRUNK,
    voxelX: 0,
    voxelY: 0,
    voxelZ: 0,
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    distance: 0,
  };
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

  /**
   * Mesher used only for re-meshing edited chunks on the calling thread.
   * Streaming meshes on workers, but an edit has to be reflected this frame
   * -- a round trip to a worker would show the player a hole appearing one
   * or two frames after they dug it. A dig touches at most a handful of
   * chunks, so the cost is bounded.
   */
  private readonly editMesher = new Mesher();

  /** Reused by digSphere so a held scoop does not allocate per tick. */
  private readonly dirtyScratch = new Set<ChunkKey>();

  private readonly trees = new Map<number, Tree>();
  /** Which chunk spawned which trees, so unloading a chunk unloads them. */
  private readonly treesByChunk = new Map<ChunkKey, number[]>();
  /**
   * Tree edit persistence, and the whole of it: where a tree was cut
   * (metres above its base) and which of its foliage clusters have been
   * knocked off. A chopped tree streaming back in comes back as the stump
   * it was left as rather than growing its top back.
   *
   * Never pruned. Two numbers per tree the player has actually touched is
   * not a leak worth code.
   */
  private readonly severedTrees = new Map<number, number>();
  private readonly strippedFoliage = new Map<number, number>();
  private readonly placementScratch: Placement[] = [];

  private readonly props = new Map<number, Prop>();
  /**
   * Uses left on each prop's resources, by entry, for props that have been
   * harvested at least once. Like severedTrees, never pruned: a few numbers
   * per thing the player has actually touched.
   */
  private readonly propUses = new Map<number, number[]>();

  /** Trees the in-flight raycast might hit. Refilled per raycast. */
  private readonly rayTrees: Tree[] = [];
  private readonly rayProps: Prop[] = [];
  /** What the in-flight raycast last found solid. Filled by treeSolidAt. */
  private rayHitTree: Tree | undefined;
  private rayHitProp: Prop | undefined;
  private rayHitPart = TREE_PART_TRUNK;
  private readonly rayHit = createVoxelHit();
  /**
   * Allocated once in the constructor rather than per raycast: this closes
   * over `this` and is called once per voxel the ray crosses.
   */
  private readonly sceneQuery = {
    isSolid: (vx: number, vy: number, vz: number): boolean =>
      isSolid(this.materialAt(vx, vy, vz)) ||
      this.treeSolidAt(vx, vy, vz) ||
      this.propSolidAt(vx, vy, vz),
  };

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
   * Biome blend weights at a world position in **metres**, written into
   * `out`. Named for its unit on purpose: everything else on World that
   * takes a world position takes voxels.
   *
   * Reads the generator rather than the loaded chunks, so it answers for
   * positions outside the loaded radius too -- which is what the renderer
   * needs to fade the sky toward a region before the player reaches it.
   */
  biomeAtMeters(metersX: number, metersZ: number, out: BiomeWeights): BiomeWeights {
    return this.generator.biomeAt(
      Math.floor(metersX / VOXEL_SIZE),
      Math.floor(metersZ / VOXEL_SIZE),
      out,
    );
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
      const spawned = this.treesByChunk.get(key);
      if (spawned !== undefined) {
        for (const id of spawned) {
          if (this.props.delete(id)) {
            sink.onPropUnloaded(id);
            continue;
          }
          this.trees.delete(id);
          sink.onTreeUnloaded(id);
        }
        this.treesByChunk.delete(key);
      }
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
        columnTint: result.columnTint,
      });
      sink.onChunkLoaded(result);
      this.spawnVegetation(result.key, sink);
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

  /**
   * Removes hand-diggable material within `radiusMeters` of a world-space
   * point, skipping voxels in unloaded chunks (it never force-loads), then
   * re-meshes only the chunks actually touched. Ports World::digSphere.
   *
   * Returns the number of chunks re-meshed, which is 0 when the dig hit
   * nothing removable -- Rock and Granite need a tool the game does not
   * have yet, so clicking at a rock face is a legitimate no-op.
   */
  digSphere(centerX: number, centerY: number, centerZ: number, radiusMeters: number, sink: ChunkSink): number {
    const centerVoxelX = Math.floor(centerX / VOXEL_SIZE);
    const centerVoxelY = Math.floor(centerY / VOXEL_SIZE);
    const centerVoxelZ = Math.floor(centerZ / VOXEL_SIZE);
    const r = Math.ceil(radiusMeters / VOXEL_SIZE);
    const radiusSq = radiusMeters * radiusMeters;

    const dirty = this.dirtyScratch;
    dirty.clear();

    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const wx = centerVoxelX + dx;
          const wy = centerVoxelY + dy;
          const wz = centerVoxelZ + dz;

          // Distance from the sphere centre to the voxel's centre, matching
          // the C++ exactly -- a corner-based test would carve a visibly
          // different shape.
          const ox = (wx + 0.5) * VOXEL_SIZE - centerX;
          const oy = (wy + 0.5) * VOXEL_SIZE - centerY;
          const oz = (wz + 0.5) * VOXEL_SIZE - centerZ;
          if (ox * ox + oy * oy + oz * oz > radiusSq) continue;

          const cx = floorDiv(wx, CHUNK_SIZE);
          const cy = floorDiv(wy, CHUNK_SIZE);
          const cz = floorDiv(wz, CHUNK_SIZE);
          const key = chunkKey(cx, cy, cz);
          const grid = this.chunks.get(key);
          if (grid === undefined) continue;

          const index = gridIndex(
            grid,
            floorMod(wx, CHUNK_SIZE),
            floorMod(wy, CHUNK_SIZE),
            floorMod(wz, CHUNK_SIZE),
          );
          const material = grid.cells[index] as Material;
          if (material === Material.Air || !isHandDiggable(material)) continue;

          grid.cells[index] = Material.Air;
          dirty.add(key);
        }
      }
    }

    // TODO(voxel-physics, not yet implemented): voxels dug out from
    // underneath are left hanging with no support check. The named seam for
    // connectivity analysis is World::digSphere's checkForFloatingVoxelsStub
    // in the C++; it is a deliberate no-op there too, and belongs here once
    // the dynamic-body work at M7/M8 gives newly-floating clusters somewhere
    // to go.

    for (const key of dirty) {
      const grid = this.chunks.get(key);
      if (grid === undefined) continue;
      const mesh = this.editMesher.mesh(grid);
      sink.onChunkRemeshed(key, keyX(key), keyY(key), keyZ(key), mesh.vertices, mesh.vertexCount);
    }
    return dirty.size;
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

  /**
   * Meshes a loaded chunk on the calling thread, for a caller that needs
   * its triangles rather than its voxels -- today, building a static
   * collision shape for it.
   *
   * The returned view is the shared edit mesher's scratch and is
   * invalidated by the next edit or call. Consume it before yielding.
   */
  meshChunk(cx: number, cy: number, cz: number): MeshData | undefined {
    const grid = this.chunks.get(chunkKey(cx, cy, cz));
    if (grid === undefined) return undefined;
    return this.editMesher.mesh(grid);
  }

  // --- vegetation --------------------------------------------------------

  getTree(treeId: number): Tree | undefined {
    return this.trees.get(treeId);
  }

  /** Standing trees whose base is within `radius` metres of (x, z), into `out`. */
  treesNear(x: number, z: number, radius: number, out: Tree[]): Tree[] {
    out.length = 0;
    const radiusSq = radius * radius;
    for (const tree of this.trees.values()) {
      const dx = tree.x - x;
      const dz = tree.z - z;
      if (dx * dx + dz * dz <= radiusSq) out.push(tree);
    }
    return out;
  }

  get treeCount(): number {
    return this.trees.size;
  }

  getProp(propId: number): Prop | undefined {
    return this.props.get(propId);
  }

  get propCount(): number {
    return this.props.size;
  }

  private spawnVegetation(key: ChunkKey, sink: ChunkSink): void {
    const placements = placeVegetation(
      this.generator,
      keyX(key),
      keyY(key),
      keyZ(key),
      this.seed,
      this.placementScratch,
    );

    for (const placement of placements) {
      let owned = this.treesByChunk.get(key);
      if (owned === undefined) {
        owned = [];
        this.treesByChunk.set(key, owned);
      }

      if (placement.type === "bush") {
        owned.push(placement.id);
        sink.onBushPlaced(
          placement.id,
          (placement.rootVoxelX + 0.5) * VOXEL_SIZE,
          placement.rootVoxelY * VOXEL_SIZE,
          (placement.rootVoxelZ + 0.5) * VOXEL_SIZE,
          placement.sizeMeters,
        );
        continue;
      }

      if (placement.type === "prop") {
        if (this.props.has(placement.id)) continue;
        const metrics = PROP_METRICS[placement.kind];
        const prop: Prop = {
          id: placement.id,
          kind: placement.kind,
          biome: placement.biome,
          x: placement.x,
          y: placement.y,
          z: placement.z,
          scale: placement.scale,
          yaw: placement.yaw,
          tiltX: placement.tiltX,
          tiltZ: placement.tiltZ,
          topsoil: placement.topsoil,
          loot: placement.loot,
          radius: metrics.radius * placement.scale,
          height: metrics.height * placement.scale,
        };
        this.props.set(prop.id, prop);
        owned.push(prop.id);
        sink.onPropPlaced(prop);
        continue;
      }

      // A tree whose chunk is reloaded while the tree is somehow still
      // alive must not be duplicated.
      if (this.trees.has(placement.id)) continue;

      const shape = treeShape(placement.id, placement.species);
      // A species with no metrics is not placeable. Nothing generates one
      // today, but a half-added species should leave a gap in the forest
      // rather than throw inside streaming.
      if (shape === undefined) continue;

      const cutAt = this.severedTrees.get(placement.id);
      const clusters = metricsFor(placement.species)?.foliage.length ?? 0;
      const intactMask = (1 << clusters) - 1;
      const tree: Tree = {
        id: placement.id,
        species: placement.species,
        biome: placement.biome,
        // Roots sit on the voxel lattice, so the base is the centre of the
        // surface voxel's top face.
        x: (placement.rootVoxelX + 0.5) * VOXEL_SIZE,
        y: placement.rootVoxelY * VOXEL_SIZE,
        z: (placement.rootVoxelZ + 0.5) * VOXEL_SIZE,
        scale: shape.scale,
        yaw: shape.yaw,
        heightMeters: shape.heightMeters,
        trunkRadiusMeters: shape.trunkRadiusMeters,
        trunkTopMeters: cutAt ?? shape.trunkTopMeters,
        foliageMask: intactMask & ~(this.strippedFoliage.get(placement.id) ?? 0),
        severed: cutAt !== undefined,
        chopHeightMeters: 0,
        chopHits: 0,
      };

      this.trees.set(tree.id, tree);
      owned.push(tree.id);

      sink.onTreePlaced(tree);
    }
  }

  /**
   * One swing at a prop's resources. Returns the item name it gave up, if it
   * did: each resource entry in the sheet is rolled in turn at its drop
   * rarity, and each can be given up only `uses` times in all.
   *
   * `random` is passed in so the sim stays deterministic: the client hands
   * it Math.random, a server would hand it a seeded generator.
   */
  harvestProp(propId: number, random: () => number): string | undefined {
    const prop = this.props.get(propId);
    if (prop === undefined) return undefined;
    const resources = OBJECT_SHEET[prop.kind].resources;
    if (resources === undefined) return undefined;

    let uses = this.propUses.get(propId);
    if (uses === undefined) {
      uses = resources.map((entry) => entry.uses);
      this.propUses.set(propId, uses);
    }
    for (let i = 0; i < resources.length; i++) {
      const entry = resources[i];
      if (entry === undefined || (uses[i] ?? 0) <= 0) continue;
      if (random() >= DROP_CHANCE[entry.rarity]) continue;
      uses[i] = (uses[i] ?? 0) - 1;
      return entry.item;
    }
    return undefined;
  }

  /** Whether anything is left to harvest from a prop, for the crosshair readout. */
  propHasResources(propId: number): boolean {
    const prop = this.props.get(propId);
    const resources = prop === undefined ? undefined : OBJECT_SHEET[prop.kind].resources;
    if (resources === undefined) return false;
    const uses = this.propUses.get(propId);
    return resources.some((entry, i) => (uses?.[i] ?? entry.uses) > 0);
  }

  /**
   * Cleared before each cast. A method rather than an assignment at the
   * call site so the compiler does not narrow the field to undefined for
   * the rest of the cast -- it cannot see that the DDA calls back into
   * treeSolidAt in between.
   */
  private clearRayHit(): void {
    this.rayHitTree = undefined;
    this.rayHitProp = undefined;
  }

  /**
   * Whether a prop's aiming cylinder covers a world voxel. Props are not
   * solid to the player; this exists so the crosshair can find them.
   */
  private propSolidAt(vx: number, vy: number, vz: number): boolean {
    if (this.rayProps.length === 0) return false;
    const px = (vx + 0.5) * VOXEL_SIZE;
    const py = (vy + 0.5) * VOXEL_SIZE;
    const pz = (vz + 0.5) * VOXEL_SIZE;
    for (const prop of this.rayProps) {
      const dy = py - prop.y;
      if (dy < 0 || dy > prop.height) continue;
      const dx = px - prop.x;
      const dz = pz - prop.z;
      if (dx * dx + dz * dz <= prop.radius * prop.radius) {
        this.rayHitProp = prop;
        return true;
      }
    }
    return false;
  }

  /**
   * Whether a tree in the ray set covers a world voxel, and which part of
   * which tree it was. A trunk is a cylinder and a foliage cluster is an
   * on-axis ellipsoid -- crude, but a tree is a thin pole inside a blob,
   * and those are exactly the two shapes that describes.
   *
   * The yaw does not enter into it: both shapes are rotationally symmetric
   * about the trunk, so the planted rotation changes the mesh and nothing
   * that is tested here.
   */
  private treeSolidAt(vx: number, vy: number, vz: number): boolean {
    const px = (vx + 0.5) * VOXEL_SIZE;
    const py = (vy + 0.5) * VOXEL_SIZE;
    const pz = (vz + 0.5) * VOXEL_SIZE;

    for (const tree of this.rayTrees) {
      const dx = px - tree.x;
      const dy = py - tree.y;
      const dz = pz - tree.z;
      const horizontalSq = dx * dx + dz * dz;

      if (
        dy >= 0 &&
        dy <= tree.trunkTopMeters &&
        horizontalSq <= tree.trunkRadiusMeters * tree.trunkRadiusMeters
      ) {
        this.rayHitTree = tree;
        this.rayHitPart = TREE_PART_TRUNK;
        return true;
      }

      const foliage = metricsFor(tree.species)?.foliage;
      if (foliage === undefined) continue;
      for (let i = 0; i < foliage.length; i++) {
        if ((tree.foliageMask & (1 << i)) === 0) continue;
        const cluster = foliage[i];
        if (cluster === undefined) continue;
        const radiusXZ = cluster.radiusXZ * tree.scale;
        const radiusY = cluster.radiusY * tree.scale;
        const offsetY = (dy - cluster.y * tree.scale) / radiusY;
        if (horizontalSq / (radiusXZ * radiusXZ) + offsetY * offsetY <= 1) {
          this.rayHitTree = tree;
          this.rayHitPart = i;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Casts against terrain and trees at once and reports what was hit.
   *
   * One DDA over world voxels covers both: the ray steps voxels, and each
   * step asks the terrain for its material and the nearby trees whether
   * their trunk or foliage shapes contain that voxel's centre. Voxel
   * granularity on a mesh tree is coarser than the mesh, but the shapes
   * being tested are approximations anyway, and this keeps one raycast
   * rather than one per tree -- which is where the C++'s "nearest hit"
   * bugs came from.
   */
  raycastScene(
    originX: number,
    originY: number,
    originZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    maxDistanceMeters: number,
    out: SceneHit,
  ): SceneHit {
    // Broad phase: a tree can only be hit if its base is within reach plus
    // its own canopy radius. Canopies are at most ~2m across, hence the
    // slack.
    const reach = maxDistanceMeters + 4;
    const reachSq = reach * reach;
    this.rayTrees.length = 0;
    for (const tree of this.trees.values()) {
      const ox = tree.x - originX;
      const oz = tree.z - originZ;
      if (ox * ox + oz * oz <= reachSq) this.rayTrees.push(tree);
    }
    // Props are metre-scale and a cylinder is their whole shape, so the
    // same slack covers them. Graves are not aimable at all (height 0).
    this.rayProps.length = 0;
    for (const prop of this.props.values()) {
      if (prop.height <= 0) continue;
      const ox = prop.x - originX;
      const oz = prop.z - originZ;
      if (ox * ox + oz * oz <= reachSq) this.rayProps.push(prop);
    }
    this.clearRayHit();

    const hit = raycastVoxel(
      this.sceneQuery,
      originX,
      originY,
      originZ,
      dirX,
      dirY,
      dirZ,
      maxDistanceMeters,
      this.rayHit,
    );

    if (!hit.hit) {
      out.kind = HitKind.None;
      return out;
    }

    // The DDA stops on the voxel the solid query last answered for, so the
    // tree or prop and part it recorded are that voxel's -- no second lookup.
    const tree = this.rayHitTree;
    const prop = this.rayHitProp;
    out.kind =
      tree !== undefined ? HitKind.Tree : prop !== undefined ? HitKind.Prop : HitKind.Terrain;
    out.treeId = tree?.id ?? 0;
    out.propId = prop?.id ?? 0;
    out.treePart = tree === undefined ? TREE_PART_TRUNK : this.rayHitPart;
    out.voxelX = hit.x;
    out.voxelY = hit.y;
    out.voxelZ = hit.z;
    out.centerX = (hit.x + 0.5) * VOXEL_SIZE;
    out.centerY = (hit.y + 0.5) * VOXEL_SIZE;
    out.centerZ = (hit.z + 0.5) * VOXEL_SIZE;
    out.distance = hit.distance;
    return out;
  }

  /**
   * Scoop on a tree: knocks one whole foliage cluster off, which is the
   * mesh equivalent of the voxel build's scooping leaves away a handful at
   * a time. A cluster is the smallest piece of canopy the artist authored,
   * so it is also the smallest piece that can come off.
   *
   * Trunks are not scoopable -- they are chup-only, as before.
   */
  stripFoliage(treeId: number, cluster: number, sink: ChunkSink): boolean {
    const tree = this.trees.get(treeId);
    if (tree === undefined) return false;
    if (cluster < 0) return false;
    const bit = 1 << cluster;
    if ((tree.foliageMask & bit) === 0) return false;

    tree.foliageMask &= ~bit;
    this.strippedFoliage.set(treeId, (this.strippedFoliage.get(treeId) ?? 0) | bit);
    sink.onTreeFoliageRemoved(tree, cluster);
    return true;
  }

  /**
   * Chup on a trunk, at a world height. Returns whether the swing landed,
   * and whether it was the one that cut through.
   *
   * A swing lands anywhere on the standing trunk; it takes CHOPS_TO_FELL of
   * them at roughly one height to cut through. The cut itself is where the
   * "procedural" part of the destruction lives, and it is deliberately
   * trivial: a trunk is a tapered cylinder, so cutting it is one number
   * going down and a piece of known length coming off. The sink slices the
   * authored mesh to match.
   */
  chopTree(treeId: number, hitHeightMeters: number, sink: ChunkSink): ChopResult {
    const tree = this.trees.get(treeId);
    if (tree === undefined || tree.trunkTopMeters <= 0) return NO_CHOP;

    const local = hitHeightMeters - tree.y;
    if (local < 0 || local > tree.trunkTopMeters) return NO_CHOP;

    if (Math.abs(local - tree.chopHeightMeters) > CHOP_REANCHOR_METERS || tree.chopHits === 0) {
      tree.chopHeightMeters = local;
      tree.chopHits = 0;
    }
    tree.chopHits++;
    if (tree.chopHits < CHOPS_TO_FELL) return { landed: true, felled: false };

    // Where the cut actually falls. A cut too near the top would drop a
    // stub, and one too near the ground would leave a stump you cannot
    // chop again -- so a trunk short enough that both cannot be satisfied
    // goes over whole, which is also how a stump is finally cleared.
    let cut = Math.min(tree.chopHeightMeters, tree.trunkTopMeters - MIN_PIECE_METERS);
    if (cut < MIN_STUMP_METERS) cut = 0;

    const pieceLength = tree.trunkTopMeters - cut;
    const foliage = metricsFor(tree.species)?.foliage ?? [];
    let carried = 0;
    for (let i = 0; i < foliage.length; i++) {
      const cluster = foliage[i];
      if (cluster === undefined) continue;
      if ((tree.foliageMask & (1 << i)) === 0) continue;
      // A cluster rides with the piece if its centre is above the cut. A
      // skirt straddling the cut goes with whichever side holds its middle,
      // which is wrong by a few leaves and right about where the branch is.
      if (cluster.y * tree.scale > cut) carried |= 1 << i;
    }

    tree.trunkTopMeters = cut;
    tree.foliageMask &= ~carried;
    tree.severed = true;
    tree.chopHits = 0;
    this.severedTrees.set(tree.id, cut);
    if (carried !== 0) {
      this.strippedFoliage.set(tree.id, (this.strippedFoliage.get(tree.id) ?? 0) | carried);
    }

    sink.onTreeCut(tree, cut, pieceLength, carried);
    return { landed: true, felled: true };
  }

  dispose(): void {
    this.source.dispose();
  }
}
