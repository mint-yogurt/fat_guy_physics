import { chunkKey, keyX, keyY, keyZ, type ChunkKey } from "./chunkKey.ts";
import type { ChunkResult, ChunkSource } from "./chunkSource.ts";
import { CHUNK_SIZE, VOXEL_SIZE } from "./constants.ts";
import { nowMs } from "./time.ts";
import { sectionAtHeight, sectionsOf, standingSections } from "./propDamage.ts";
import { createVoxelHit, raycastVoxel } from "../voxel/voxelRaycast.ts";
import { Biome } from "../voxel/biomeTint.ts";
import type { PlacedPropSave, WorldEdits } from "../save/snapshot.ts";
import { createBiomeWeights, type BiomeWeights } from "../worldgen/biome.ts";
import { DROP_CHANCE, OBJECT_SHEET, type DropRow } from "../worldgen/generationSheet.ts";
import {
  gradientInTile,
  heightInTile,
  latticeCells,
  TILE_METERS,
  tileOf,
} from "../worldgen/groundField.ts";
import { groundBlend, type GroundBlend } from "../worldgen/groundMesh.ts";
import { PROP_METRICS, type PropKind, type PropSection } from "../worldgen/props.ts";
import { placeVegetation, type Placement } from "../worldgen/spawns.ts";
import { TerrainGenerator } from "../worldgen/terrainGenerator.ts";
import { metricsFor, TreeSpecies, treeLightCount, treeShape } from "../worldgen/trees.ts";

/**
 * Ground-tile streaming and the world's things (trees, props, rocks). Descends from the data
 * half of src/voxel/World.{hpp,cpp}, from when the ground was voxels; it no longer is (see
 * DESIGN.md), so the "chunk" here is a tile of heightfield, one column wide.
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
 * How high above the origin the world is allowed to hold anything (a restored save is clamped
 * to it). Cliffs and tiered bluffs reach 6.4 m base + ~9 m.
 */
export const WORLD_CEILING_METERS = 16;

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
  /**
   * A prop already placed changed: a snowbank shrank, or a snowman lost a
   * part (`prop.scale`, `prop.broken`). Optional so a sink that draws nothing can skip it.
   */
  onPropChanged?(prop: Prop): void;
  /**
   * A rock came into range for the first time. Once told, the world never
   * places it again: from here it is the game's to move, carry or lose.
   */
  onRockPlaced(rock: PlacedRock): void;
  /** One foliage cluster was knocked off. The tree keeps standing. */
  onTreeFoliageRemoved(tree: Tree, cluster: number): void;
  /** The strings of lights hung on a tree were knocked off it (`tree.lights` is already 0). */
  onTreeLightsRemoved(tree: Tree): void;
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
  /** Strings of xmas lights still hung on it. A first strike knocks them all off. */
  lights: number;
}

/** A rock as the world generated it: lying on the ground at (x, y, z), `scale` times a standard rock. */
export interface PlacedRock {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly scale: number;
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
  /** Authored units to metres. Shrinks as a snowbank is used up. */
  scale: number;
  /** What `scale` was when it was placed. */
  readonly fullScale: number;
  readonly yaw: number;
  /** Lean about its own X and Z, radians; at most one is non-zero. */
  readonly tiltX: number;
  readonly tiltZ: number;
  /** Graves: covered, or open. */
  readonly topsoil: boolean;
  /** Item names inside, for a container. */
  readonly loot: readonly string[];
  /** Aiming cylinder, metres. Zero height means it cannot be aimed at. Follows `scale` and the parts still standing. */
  radius: number;
  height: number;
  /**
   * Parts that have come off (a snowman), one bit per `PROP_SECTIONS` entry
   * from the bottom. 1 on a breakable prop (a house) in the moment it explodes.
   */
  broken: number;
}

/** A part of a prop that came off, where its middle was. */
export interface BrokenSection {
  readonly index: number;
  readonly section: PropSection;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

/** What a blow on a prop did. */
export interface PropHit {
  /** The part it landed on. */
  readonly section: number;
  /** Parts that came off, the one hit first and then each above it. Empty if it only hurt. */
  readonly broken: readonly BrokenSection[];
  /** What the prop released (item name, how many), if the part with the drops came off. */
  readonly drops: readonly DropRow[];
  /** Nothing is left: the prop has been removed. */
  readonly gone: boolean;
}

/** A depleting prop (a snowbank) never shrinks below this fraction of its size until it is gone. */
const DEPLETED_MIN_SCALE = 0.3;

/** What the ground is like at a point; see {@link World.groundSurface}. */
export interface GroundSurface extends GroundBlend {
  /** Height of the ground there, metres. */
  height: number;
}

export function createGroundSurface(): GroundSurface {
  return { height: 0, grass: 0, dirt: 0, snow: 0, spooky: 0 };
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
  /** Strings of xmas lights this swing knocked off the tree. */
  readonly lightsDropped: number;
}

const NO_CHOP: ChopResult = { landed: false, felled: false, lightsDropped: 0 };

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
  /**
   * The voxel face the ray came in through (unit, one axis). A tree or a prop
   * is made of voxels to the ray too, so for those it is only a rough answer:
   * a caller that wants the round surface works it out from the thing itself.
   */
  normalX: number;
  normalY: number;
  normalZ: number;
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
    normalX: 0,
    normalY: 1,
    normalZ: 0,
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
      out.add(chunkKey(centerX + dx, 0, centerZ + dz));
    }
  }
  return out;
}

function columnKey(cx: number, cz: number): string {
  return `${String(cx)},${String(cz)}`;
}

export class World {
  private readonly generator: TerrainGenerator;
  /** Loaded ground tiles' lattices (groundField.ts), by tile key (cy is 0). */
  private readonly tiles = new Map<ChunkKey, Float32Array>();
  private readonly desired = new Set<ChunkKey>();
  private readonly inFlight = new Set<ChunkKey>();

  /** Scratch for the distance sort in submitDesired. Reused, never freed. */
  private readonly submitQueue: ChunkKey[] = [];

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
  /** Trees whose lights have been knocked off. Never pruned, like the above. */
  private readonly strippedLights = new Set<number>();
  private readonly placementScratch: Placement[] = [];

  private readonly props = new Map<number, Prop>();
  /** Generated props the player picked up. Never regenerated; never pruned, like severedTrees. */
  private readonly removedProps = new Set<number>();
  /**
   * Props the player placed, by chunk column ("cx,cz"): they come back whenever
   * any chunk of the column streams in. Their ids start above every generated
   * (32-bit) id, so the two never collide.
   */
  private readonly placedProps = new Map<string, Prop[]>();
  private nextPlacedPropId = 0x1_0000_0000;
  private readonly biomeScratch: BiomeWeights = createBiomeWeights();
  /** Rocks already handed to the game, so reloading their chunk does not place them twice. */
  private readonly rocksPlaced = new Set<number>();
  /**
   * Uses left on each prop's resources, by entry, for props that have been
   * harvested at least once. Like severedTrees, never pruned: a few numbers
   * per thing the player has actually touched.
   */
  private readonly propUses = new Map<number, number[]>();
  /** Damage taken by each part of a prop that has been hit, by prop id. Kept like `propUses`. */
  private readonly propDamage = new Map<number, number[]>();
  /** Which parts of a prop have come off, by prop id, so a regenerated chunk brings it back as it was. */
  private readonly propBroken = new Map<number, number>();
  /** Bumped by every change a save would need to record; see {@link editRevision}. */
  private revision = 0;

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
      this.isSolid(vx, vy, vz) ||
      this.treeSolidAt(vx, vy, vz) ||
      this.propSolidAt(vx, vy, vz),
  };

  private readonly gradientScratch = { x: 0, z: 0 };
  private readonly normalScratch = { x: 0, y: 1, z: 0 };

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
    return this.tiles.size;
  }

  /** Changes whenever the world is edited, so a saver can skip writing an unchanged world. */
  get editRevision(): number {
    return this.revision;
  }

  /** Chunks submitted but not yet drained. Zero means streaming has settled. */
  get pendingCount(): number {
    return this.inFlight.size;
  }

  get radius(): number {
    return this.loadRadiusChunks;
  }

  /**
   * Ground height in metres at a world position in metres: the height of the mesh the player
   * sees and stands on, from the loaded tile when there is one and straight from the
   * generator otherwise (so it also answers outside the loaded area).
   */
  groundHeight(xMeters: number, zMeters: number): number {
    const cx = tileOf(xMeters);
    const cz = tileOf(zMeters);
    const lattice = this.tiles.get(chunkKey(cx, 0, cz));
    if (lattice === undefined) return this.generator.groundHeight(xMeters, zMeters);
    return heightInTile(lattice, cx, cz, xMeters, zMeters);
  }

  /**
   * The ground's height at the centre of a world voxel column, in voxel units (so a caller
   * that works in voxels can keep doing so). Smooth, not a whole number: multiply by
   * VOXEL_SIZE for metres, or just call {@link groundHeight}.
   */
  surfaceHeightVoxels(worldX: number, worldZ: number): number {
    return this.groundHeight((worldX + 0.5) * VOXEL_SIZE, (worldZ + 0.5) * VOXEL_SIZE) / VOXEL_SIZE;
  }

  /**
   * What the ground is at (x, z), in metres: height and how much grass, dirt and snow shows
   * (for the map). False when that tile is not loaded.
   */
  groundSurface(xMeters: number, zMeters: number, out: GroundSurface): boolean {
    const cx = tileOf(xMeters);
    const cz = tileOf(zMeters);
    const lattice = this.tiles.get(chunkKey(cx, 0, cz));
    if (lattice === undefined) return false;
    out.height = heightInTile(lattice, cx, cz, xMeters, zMeters);
    gradientInTile(lattice, cx, cz, xMeters, zMeters, this.gradientScratch);
    groundBlend(
      this.generator,
      xMeters,
      zMeters,
      Math.hypot(this.gradientScratch.x, this.gradientScratch.z),
      out,
    );
    return true;
  }

  /**
   * The ground's up-facing unit normal at (x, z), from the triangle under the point. Flat
   * (0, 1, 0) when the tile is not loaded.
   */
  groundNormal(xMeters: number, zMeters: number, out: { x: number; y: number; z: number }): void {
    const cx = tileOf(xMeters);
    const cz = tileOf(zMeters);
    const lattice = this.tiles.get(chunkKey(cx, 0, cz));
    if (lattice === undefined) {
      out.x = 0;
      out.y = 1;
      out.z = 0;
      return;
    }
    gradientInTile(lattice, cx, cz, xMeters, zMeters, this.gradientScratch);
    const g = this.gradientScratch;
    const length = Math.hypot(g.x, 1, g.z);
    out.x = -g.x / length;
    out.y = 1 / length;
    out.z = -g.z / length;
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
    const centerX = tileOf(worldX);
    const centerZ = tileOf(worldZ);
    if (this.hasCenter && centerX === this.centerX && centerZ === this.centerZ) {
      return 0;
    }
    this.hasCenter = true;
    this.centerX = centerX;
    this.centerZ = centerZ;

    desiredChunkSet(centerX, centerZ, this.loadRadiusChunks, this.desired);

    for (const key of this.tiles.keys()) {
      if (this.desired.has(key)) continue;
      this.tiles.delete(key);
      sink.onChunkUnloaded(key);
      const spawned = this.treesByChunk.get(key);
      if (spawned !== undefined) {
        for (const id of spawned) {
          if (this.props.delete(id)) {
            sink.onPropUnloaded(id);
            continue;
          }
          if (this.removedProps.has(id)) continue;
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
      if (this.tiles.has(key) || this.inFlight.has(key)) continue;
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

      // The sink gets the result's buffers; the world keeps its own copy of the small lattice.
      this.tiles.set(result.key, result.lattice.slice());
      sink.onChunkLoaded(result);
      this.spawnVegetation(result.key, sink);
      uploaded++;
    }
    return uploaded === 0 ? 0 : nowMs() - started;
  }

  /**
   * Everything players have changed that this class owns, as plain data (see
   * save/snapshot.ts). Clients and a server both save the world through this.
   */
  exportEdits(): WorldEdits {
    const placedProps: PlacedPropSave[] = [];
    for (const column of this.placedProps.values()) {
      for (const prop of column) {
        placedProps.push({
          id: prop.id,
          kind: prop.kind,
          biome: prop.biome,
          x: prop.x,
          y: prop.y,
          z: prop.z,
          yaw: prop.yaw,
          scale: prop.scale,
          fullScale: prop.fullScale,
          loot: [...prop.loot],
          broken: prop.broken,
        });
      }
    }
    return {
      seed: this.seed,
      severedTrees: [...this.severedTrees],
      strippedFoliage: [...this.strippedFoliage],
      strippedLights: [...this.strippedLights],
      removedProps: [...this.removedProps],
      placedProps,
      nextPlacedPropId: this.nextPlacedPropId,
      propUses: [...this.propUses].map(([id, uses]) => [id, [...uses]] as const),
      propDamage: [...this.propDamage].map(([id, damage]) => [id, [...damage]] as const),
      propBroken: [...this.propBroken],
    };
  }

  /**
   * Loads edits made in an earlier session (already through `sanitizeWorldSave`).
   * Must come before the first {@link update}: tiles that have already streamed in
   * were populated without them. Edits from a different seed are ignored, since their
   * ids mean nothing here.
   */
  importEdits(edits: WorldEdits): void {
    if (this.tiles.size > 0 || this.inFlight.size > 0) {
      throw new Error("World.importEdits must run before any chunk is requested");
    }
    if (edits.seed !== this.seed) return;

    for (const [id, cutAt] of edits.severedTrees) this.severedTrees.set(id, cutAt);
    for (const [id, mask] of edits.strippedFoliage) this.strippedFoliage.set(id, mask);
    for (const id of edits.strippedLights) this.strippedLights.add(id);
    for (const id of edits.removedProps) this.removedProps.add(id);
    for (const [id, uses] of edits.propUses) this.propUses.set(id, [...uses]);
    for (const [id, damage] of edits.propDamage) this.propDamage.set(id, [...damage]);
    for (const [id, mask] of edits.propBroken) this.propBroken.set(id, mask);
    this.nextPlacedPropId = Math.max(this.nextPlacedPropId, edits.nextPlacedPropId);

    for (const saved of edits.placedProps) {
      const metrics = PROP_METRICS[saved.kind as PropKind];
      const prop: Prop = {
        id: saved.id,
        kind: saved.kind as PropKind,
        biome: saved.biome as Biome,
        x: saved.x,
        y: saved.y,
        z: saved.z,
        scale: saved.scale,
        fullScale: saved.fullScale,
        yaw: saved.yaw,
        tiltX: 0,
        tiltZ: 0,
        topsoil: false,
        loot: saved.loot,
        radius: metrics.radius * saved.scale,
        height: metrics.height * saved.scale,
        broken: saved.broken,
      };
      this.fitToWear(prop);
      const column = columnKey(
        tileOf(prop.x),
        tileOf(prop.z),
      );
      const list = this.placedProps.get(column);
      if (list === undefined) this.placedProps.set(column, [prop]);
      else list.push(prop);
    }
    this.revision++;
  }

  /** Whether the ground tile under a world-space point (metres) is loaded. Height is ignored. */
  hasChunkAt(worldX: number, _worldY: number, worldZ: number): boolean {
    return this.tiles.has(chunkKey(tileOf(worldX), 0, tileOf(worldZ)));
  }

  /**
   * {@link SolidQuery} for the collision code: a voxel cell is solid when its centre is below
   * the ground. The collision code still thinks in 10 cm cells (felled logs and building
   * pieces join through a composite query, see sceneQuery.ts); the ground is the smooth mesh
   * sampled at those cells' centres. Unloaded tiles are empty, as before.
   */
  isSolid(vx: number, vy: number, vz: number): boolean {
    const x = (vx + 0.5) * VOXEL_SIZE;
    const z = (vz + 0.5) * VOXEL_SIZE;
    const cx = tileOf(x);
    const cz = tileOf(z);
    const lattice = this.tiles.get(chunkKey(cx, 0, cz));
    if (lattice === undefined) return false;
    return (vy + 0.5) * VOXEL_SIZE < heightInTile(lattice, cx, cz, x, z);
  }

  /**
   * The triangles of a loaded ground tile as a flat list of x, y, z (tile-local x and z,
   * absolute y), for building a static collision shape. Same triangles as the rendered mesh.
   * Undefined when the tile is not loaded.
   */
  groundTriangles(cx: number, cz: number): Float32Array | undefined {
    const lattice = this.tiles.get(chunkKey(cx, 0, cz));
    if (lattice === undefined) return undefined;
    const cells = latticeCells(lattice);
    const side = cells + 1;
    const step = TILE_METERS / cells;
    const out = new Float32Array(cells * cells * 6 * 3);
    let at = 0;
    const emit = (i: number, j: number): void => {
      out[at++] = i * step;
      out[at++] = lattice[i + side * j] as number;
      out[at++] = j * step;
    };
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        emit(i, j);
        emit(i + 1, j + 1);
        emit(i + 1, j);
        emit(i, j);
        emit(i, j + 1);
        emit(i + 1, j + 1);
      }
    }
    return out;
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

  /** Props whose base is within `radius` metres of (x, z), into `out`. */
  propsNear(x: number, z: number, radius: number, out: Prop[]): Prop[] {
    out.length = 0;
    const radiusSq = radius * radius;
    for (const prop of this.props.values()) {
      const dx = prop.x - x;
      const dz = prop.z - z;
      if (dx * dx + dz * dz <= radiusSq) out.push(prop);
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

      if (placement.type === "prop" && PROP_METRICS[placement.kind].dynamic === true) {
        if (this.rocksPlaced.has(placement.id)) continue;
        this.rocksPlaced.add(placement.id);
        sink.onRockPlaced({
          id: placement.id,
          x: placement.x,
          y: placement.y,
          z: placement.z,
          yaw: placement.yaw,
          scale: placement.scale,
        });
        continue;
      }

      if (placement.type === "prop") {
        if (this.props.has(placement.id) || this.removedProps.has(placement.id)) continue;
        const metrics = PROP_METRICS[placement.kind];
        const prop: Prop = {
          id: placement.id,
          kind: placement.kind,
          biome: placement.biome,
          x: placement.x,
          y: placement.y,
          z: placement.z,
          scale: placement.scale,
          fullScale: placement.scale,
          yaw: placement.yaw,
          tiltX: placement.tiltX,
          tiltZ: placement.tiltZ,
          topsoil: placement.topsoil,
          loot: placement.loot,
          radius: metrics.radius * placement.scale,
          height: metrics.height * placement.scale,
          broken: this.propBroken.get(placement.id) ?? 0,
        };
        // Back as the player left it: a used snowbank small, a snowman missing its head.
        this.fitToWear(prop);
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
        lights:
          placement.biome === Biome.Christmas &&
          placement.species === TreeSpecies.Conifer &&
          cutAt === undefined &&
          !this.strippedLights.has(placement.id)
            ? treeLightCount(placement.id)
            : 0,
      };

      this.trees.set(tree.id, tree);
      owned.push(tree.id);

      sink.onTreePlaced(tree);
    }

    this.respawnPlacedProps(key, sink);
  }

  /** Brings back the props the player placed in this chunk's column, if they are not already up. */
  private respawnPlacedProps(key: ChunkKey, sink: ChunkSink): void {
    const placed = this.placedProps.get(columnKey(keyX(key), keyZ(key)));
    if (placed === undefined) return;
    for (const prop of placed) {
      if (this.props.has(prop.id)) continue;
      this.props.set(prop.id, prop);
      let owned = this.treesByChunk.get(key);
      if (owned === undefined) {
        owned = [];
        this.treesByChunk.set(key, owned);
      }
      owned.push(prop.id);
      sink.onPropPlaced(prop);
    }
  }

  /**
   * Puts a prop of the player's making in the world (a placed container). It is
   * a prop like any generated one -- aimable, near-able, drawn by the sink --
   * and it survives its chunk streaming out and back in.
   */
  addProp(
    kind: PropKind,
    x: number,
    y: number,
    z: number,
    yaw: number,
    scale: number,
    sink: ChunkSink,
    loot: readonly string[] = [],
  ): Prop {
    const metrics = PROP_METRICS[kind];
    const weights = this.biomeAtMeters(x, z, this.biomeScratch);
    const biome =
      weights.christmas >= weights.halloween && weights.christmas >= weights.plain
        ? Biome.Christmas
        : weights.halloween >= weights.plain
          ? Biome.Halloween
          : Biome.Plain;
    const prop: Prop = {
      id: this.nextPlacedPropId++,
      kind,
      biome,
      x,
      y,
      z,
      scale,
      fullScale: scale,
      yaw,
      tiltX: 0,
      tiltZ: 0,
      topsoil: false,
      loot,
      radius: metrics.radius * scale,
      height: metrics.height * scale,
      broken: 0,
    };
    const cx = tileOf(x);
    const cz = tileOf(z);
    const column = columnKey(cx, cz);
    const list = this.placedProps.get(column);
    if (list === undefined) this.placedProps.set(column, [prop]);
    else list.push(prop);

    this.props.set(prop.id, prop);
    this.revision++;
    // Owned by the tile of the ground it stands on, so it goes when that tile does.
    const ownerKey = chunkKey(cx, 0, cz);
    let owned = this.treesByChunk.get(ownerKey);
    if (owned === undefined) {
      owned = [];
      this.treesByChunk.set(ownerKey, owned);
    }
    owned.push(prop.id);
    sink.onPropPlaced(prop);
    return prop;
  }

  /**
   * Takes a prop out of the world for good: a generated one stays gone when its
   * chunk is regenerated; a placed one is forgotten. Returns it, or undefined
   * if there was no such prop.
   */
  removeProp(propId: number, sink: ChunkSink): Prop | undefined {
    const prop = this.props.get(propId);
    if (prop === undefined) return undefined;
    this.props.delete(propId);
    this.revision++;
    this.propUses.delete(propId);
    this.propDamage.delete(propId);
    this.propBroken.delete(propId);
    const column = this.placedProps.get(
      columnKey(tileOf(prop.x), tileOf(prop.z)),
    );
    const at = column?.findIndex((p) => p.id === propId) ?? -1;
    if (column !== undefined && at >= 0) column.splice(at, 1);
    else this.removedProps.add(propId);
    sink.onPropUnloaded(propId);
    return prop;
  }

  /**
   * One swing at a prop's resources. Returns the item name it gave up, if it
   * did: each resource entry in the sheet is rolled in turn at its drop
   * rarity, and each can be given up only `uses` times in all.
   *
   * `random` is passed in so the sim stays deterministic: the client hands
   * it Math.random, a server would hand it a seeded generator.
   */
  harvestProp(propId: number, random: () => number, sink: ChunkSink): string | undefined {
    return this.harvestPropYield(propId, random, sink)?.item;
  }

  /**
   * As {@link harvestProp}, with how many of the item came out of the swing.
   * A prop that `depletes` (a snowbank) shrinks as its uses go, and is removed,
   * through `sink`, when the last is gone.
   */
  harvestPropYield(
    propId: number,
    random: () => number,
    sink: ChunkSink,
  ): { item: string; count: number } | undefined {
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
      this.revision++;
      if (PROP_METRICS[prop.kind].depletes === true) {
        if (this.fitToWear(prop)) this.removeProp(propId, sink);
        else sink.onPropChanged?.(prop);
      }
      return { item: entry.item, count: entry.amount ?? 1 };
    }
    return undefined;
  }

  /**
   * One blow on a prop made of parts (a snowman), landing at world height `y`.
   * The part it lands on takes `amount` of damage; one that has taken all it
   * can comes off, and the parts above it with it. Returns what happened, or
   * undefined if the prop is not made of parts or none is left to hit.
   */
  damageProp(propId: number, y: number, amount: number, sink: ChunkSink): PropHit | undefined {
    const prop = this.props.get(propId);
    if (prop === undefined) return undefined;
    const sections = sectionsOf(prop.kind);
    const index = sectionAtHeight(prop, y);
    if (sections === undefined || index < 0) return undefined;

    let damage = this.propDamage.get(propId);
    if (damage === undefined) {
      damage = sections.map(() => 0);
      this.propDamage.set(propId, damage);
    }
    damage[index] = (damage[index] ?? 0) + amount;
    this.revision++;
    if ((damage[index] ?? 0) < (sections[index] as PropSection).hits) {
      return { section: index, broken: [], drops: [], gone: false };
    }

    const broken: BrokenSection[] = [];
    const drops: DropRow[] = [];
    for (let i = index; i < sections.length; i++) {
      if ((prop.broken & (1 << i)) !== 0) continue;
      const section = sections[i] as PropSection;
      prop.broken |= 1 << i;
      broken.push({
        index: i,
        section,
        x: prop.x,
        y: prop.y + section.centre * prop.scale,
        z: prop.z,
        radius: section.radius * prop.scale,
      });
      if (section.releasesDrops === true) drops.push(...(OBJECT_SHEET[prop.kind].drops ?? []));
    }
    this.propBroken.set(propId, prop.broken);

    if (index === 0) {
      // Told first, so the sink sees every part come off before the prop goes.
      sink.onPropChanged?.(prop);
      this.removeProp(propId, sink);
      return { section: index, broken, drops, gone: true };
    }
    this.fitToWear(prop);
    sink.onPropChanged?.(prop);
    return { section: index, broken, drops, gone: false };
  }

  /**
   * One blow on a breakable prop (a gingerbread house), from anywhere on it.
   * When it has taken all it can it is gone for good, through `sink` (told
   * first with `broken` set, so the renderer can blow it apart), and what was
   * inside comes out in `released`. Undefined if the prop is not breakable.
   */
  damageBreakable(
    propId: number,
    amount: number,
    sink: ChunkSink,
  ): { destroyed: boolean; released: readonly string[] } | undefined {
    const prop = this.props.get(propId);
    const breakable = prop === undefined ? undefined : PROP_METRICS[prop.kind].breakable;
    if (prop === undefined || breakable === undefined) return undefined;

    const damage = (this.propDamage.get(propId)?.[0] ?? 0) + amount;
    this.propDamage.set(propId, [damage]);
    this.revision++;
    if (damage < breakable.hits) return { destroyed: false, released: [] };

    prop.broken = 1;
    sink.onPropChanged?.(prop);
    this.removeProp(propId, sink);
    return { destroyed: true, released: prop.loot };
  }

  /**
   * Sizes a prop to what has been done to it: a depleting prop to the uses it
   * has left, a prop of parts to the ones still standing. True if a depleting
   * prop has nothing left at all.
   */
  private fitToWear(prop: Prop): boolean {
    const metrics = PROP_METRICS[prop.kind];
    if (metrics.depletes === true) {
      const resources = OBJECT_SHEET[prop.kind].resources ?? [];
      const uses = this.propUses.get(prop.id);
      let total = 0;
      let left = 0;
      resources.forEach((entry, i) => {
        total += entry.uses;
        left += uses?.[i] ?? entry.uses;
      });
      if (total > 0 && left <= 0) return true;
      if (total > 0) {
        prop.scale = prop.fullScale * (DEPLETED_MIN_SCALE + (1 - DEPLETED_MIN_SCALE) * (left / total));
        prop.radius = metrics.radius * prop.scale;
        prop.height = metrics.height * prop.scale;
      }
      return false;
    }
    const sections = sectionsOf(prop.kind);
    if (sections !== undefined) {
      // Aimed at as tall and wide as what is still standing.
      const standing = standingSections(prop, sections);
      let radius = 0;
      let top = 0;
      for (let i = 0; i < standing; i++) {
        const section = sections[i] as PropSection;
        radius = Math.max(radius, section.radius);
        top = section.centre + section.radius;
      }
      prop.radius = radius * prop.scale;
      prop.height = top * prop.scale;
    }
    return false;
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
    out.normalX = hit.nx;
    out.normalY = hit.ny;
    out.normalZ = hit.nz;
    if (out.kind === HitKind.Terrain) {
      // The ground is smooth, so the face the voxel ray came through is only a stand-in for
      // how the surface really faces. Hits on the ground's top (not its cliff walls, where
      // the voxel face is just as good) take the triangle's normal.
      if (hit.ny > 0.5) {
        this.groundNormal(out.centerX, out.centerZ, this.normalScratch);
        out.normalX = this.normalScratch.x;
        out.normalY = this.normalScratch.y;
        out.normalZ = this.normalScratch.z;
      }
    }
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
    this.revision++;
    sink.onTreeFoliageRemoved(tree, cluster);
    return true;
  }

  /**
   * Shakes the strings of xmas lights off a tree, for a chup or a scoop that
   * lands on it. Returns how many came off (none after the first time).
   */
  knockLights(treeId: number, sink: ChunkSink): number {
    const tree = this.trees.get(treeId);
    if (tree === undefined || tree.lights <= 0) return 0;
    const count = tree.lights;
    tree.lights = 0;
    this.strippedLights.add(treeId);
    this.revision++;
    sink.onTreeLightsRemoved(tree);
    return count;
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

    // Any strike shakes the lights loose.
    const lightsDropped = this.knockLights(treeId, sink);
    if (tree.chopHits < CHOPS_TO_FELL) return { landed: true, felled: false, lightsDropped };

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
    this.revision++;
    if (carried !== 0) {
      this.strippedFoliage.set(tree.id, (this.strippedFoliage.get(tree.id) ?? 0) | carried);
    }

    sink.onTreeCut(tree, cut, pieceLength, carried);
    return { landed: true, felled: true, lightsDropped  };
  }

  dispose(): void {
    this.source.dispose();
  }
}
