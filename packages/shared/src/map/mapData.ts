import { chunkKey, keyX, keyZ, type ChunkKey } from "../sim/chunkKey.ts";
import { nowMs } from "../sim/time.ts";
import {
  CHUNK_METERS,
  createGroundSurface,
  type Prop,
  type Tree,
  World,
} from "../sim/world.ts";
import { Biome } from "../voxel/biomeTint.ts";
import { GROUND } from "../worldgen/generationSheet.ts";
import { TREE_METRICS, TreeSpecies } from "../worldgen/trees.ts";

/**
 * The player's map: a sparse set of RGBA tiles, one per chunk column, that
 * hold what was last *seen* there.
 *
 * A tile exists only once its column has been explored, and is rewritten only
 * when the player is near it (see {@link MapData.explore}) -- so a structure
 * built across the world shows up the next time somebody walks past, not as
 * it happens. Tiles are plain bytes with no reference to the World, which is
 * what lets the whole map be sent to another player or saved as-is.
 */

/** Map pixels per chunk-column edge, and the metres each one covers. */
export const MAP_TILE_PX = 8;
export const MAP_PX_METERS = CHUNK_METERS / MAP_TILE_PX;

/** Relief shading per metre of height difference to the up-left neighbour, and its limit. */
const RELIEF_PER_METER = 0.5;
const RELIEF_MAX = 0.3;

/** The ground's colours on the map, standing in for its textures. */
const GRASS: readonly [number, number, number] = [0.3, 0.5, 0.2];
const DIRT: readonly [number, number, number] = [0.42, 0.3, 0.18];
const SNOW: readonly [number, number, number] = [0.95, 0.95, 0.97];

/** Props are drawn at least this wide so a one-pixel snowman is still visible. */
const PROP_MIN_RADIUS = 0.3;
/** Farthest a tree's canopy reaches from its base; trees this near a tile can touch it. */
const MAX_CANOPY_METERS = 3;

const PROP_COLORS: Readonly<Record<string, readonly [number, number, number]>> = {
  snowman_small: [0.98, 0.98, 1],
  snowman_big: [0.98, 0.98, 1],
  present_small: [0.85, 0.15, 0.15],
  present_big: [0.15, 0.6, 0.25],
  bucket_candy: [0.95, 0.5, 0.1],
  tombstone_1: [0.55, 0.55, 0.58],
  tombstone_2: [0.55, 0.55, 0.58],
  grave: [0.25, 0.17, 0.12],
  leafpile: [0.8, 0.45, 0.1],
  snowbank: [0.92, 0.96, 1],
  gbreadhouse_1: [0.62, 0.36, 0.17],
  hut: [0.72, 0.6, 0.3],
  // Under the hut and about the colour of the ground, so it only shows once the hut is gone.
  hut_grass: [0.3, 0.5, 0.2],
};
const DEFAULT_PROP_COLOR: readonly [number, number, number] = [0.9, 0.9, 0.2];

const CONIFER: readonly [number, number, number] = [0.1, 0.32, 0.16];
const BROADLEAF: readonly [number, number, number] = [0.22, 0.5, 0.15];
const AUTUMN: readonly [number, number, number] = [0.8, 0.4, 0.1];
const BARE_TRUNK: readonly [number, number, number] = [0.3, 0.2, 0.12];

/** One tree or prop, flattened for the per-pixel loop of a tile. */
interface Blob {
  x: number;
  z: number;
  radiusSq: number;
  color: readonly [number, number, number];
}

export class MapData {
  /** Explored tiles by chunk-column key (chunkKey(cx, 0, cz)); RGBA, alpha 0 = nothing seen. */
  readonly tiles = new Map<ChunkKey, Uint8ClampedArray>();
  /** Bumped whenever any tile changes, so a view can skip redrawing. */
  version = 0;

  private queue: ChunkKey[] = [];
  private readonly queued = new Set<ChunkKey>();
  private readonly top = createGroundSurface();
  private readonly neighbour = createGroundSurface();
  private readonly treeScratch: Tree[] = [];
  private readonly propScratch: Prop[] = [];

  tile(cx: number, cz: number): Uint8ClampedArray | undefined {
    return this.tiles.get(chunkKey(cx, 0, cz));
  }

  /**
   * Queues the columns within `radiusChunks` of a position. With `force`
   * every one is redrawn (the player is here, so what changed is now seen);
   * without it only columns never drawn are queued, which is how areas that
   * were still streaming in get picked up.
   */
  explore(x: number, z: number, radiusChunks: number, force: boolean): void {
    const centerX = Math.floor(x / CHUNK_METERS);
    const centerZ = Math.floor(z / CHUNK_METERS);
    const radiusSq = radiusChunks * radiusChunks;
    for (let dz = -radiusChunks; dz <= radiusChunks; dz++) {
      for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
        if (dx * dx + dz * dz > radiusSq) continue;
        const key = chunkKey(centerX + dx, 0, centerZ + dz);
        if (this.queued.has(key) || (!force && this.tiles.has(key))) continue;
        this.queued.add(key);
        this.queue.push(key);
      }
    }
    // Nearest first, so the ground under the player is the first thing drawn.
    this.queue.sort((a, b) => {
      const ax = keyX(a) - centerX;
      const az = keyZ(a) - centerZ;
      const bx = keyX(b) - centerX;
      const bz = keyZ(b) - centerZ;
      return ax * ax + az * az - (bx * bx + bz * bz);
    });
  }

  /**
   * Draws queued columns for up to `budgetMs`. A column whose chunks are not
   * all loaded yet is dropped from the queue rather than waited on; the
   * unforced {@link explore} sweep requeues it once it has arrived.
   */
  refresh(world: World, budgetMs: number): void {
    const started = nowMs();
    let done = 0;
    while (done < this.queue.length) {
      if (nowMs() - started >= budgetMs) break;
      const key = this.queue[done++] as ChunkKey;
      this.queued.delete(key);
      const cx = keyX(key);
      const cz = keyZ(key);
      if (!this.columnLoaded(world, cx, cz)) continue;
      let tile = this.tiles.get(key);
      if (tile === undefined) {
        tile = new Uint8ClampedArray(MAP_TILE_PX * MAP_TILE_PX * 4);
        this.tiles.set(key, tile);
      }
      this.drawTile(world, cx, cz, tile);
      this.version++;
    }
    if (done > 0) this.queue = this.queue.slice(done);
  }

  private columnLoaded(world: World, cx: number, cz: number): boolean {
    return world.hasChunkAt((cx + 0.5) * CHUNK_METERS, 0, (cz + 0.5) * CHUNK_METERS);
  }

  private drawTile(world: World, cx: number, cz: number, tile: Uint8ClampedArray): void {
    const originX = cx * CHUNK_METERS;
    const originZ = cz * CHUNK_METERS;

    // Everything that can reach this tile, gathered once rather than per pixel.
    const reach = CHUNK_METERS * Math.SQRT1_2 + MAX_CANOPY_METERS;
    const centerX = originX + CHUNK_METERS / 2;
    const centerZ = originZ + CHUNK_METERS / 2;
    const canopies: Blob[] = [];
    const trunks: Blob[] = [];
    for (const tree of world.treesNear(centerX, centerZ, reach, this.treeScratch)) {
      const canopy = canopyRadius(tree);
      if (canopy > 0) {
        canopies.push({ x: tree.x, z: tree.z, radiusSq: canopy * canopy, color: canopyColor(tree) });
      } else if (tree.trunkTopMeters > 0) {
        const r = Math.max(tree.trunkRadiusMeters, MAP_PX_METERS * 0.75);
        trunks.push({ x: tree.x, z: tree.z, radiusSq: r * r, color: BARE_TRUNK });
      }
    }
    const props: Blob[] = [];
    for (const prop of world.propsNear(centerX, centerZ, reach, this.propScratch)) {
      const r = Math.max(prop.radius, PROP_MIN_RADIUS);
      props.push({
        x: prop.x,
        z: prop.z,
        radiusSq: r * r,
        color: PROP_COLORS[prop.kind] ?? DEFAULT_PROP_COLOR,
      });
    }

    for (let py = 0; py < MAP_TILE_PX; py++) {
      for (let px = 0; px < MAP_TILE_PX; px++) {
        const mx = originX + (px + 0.5) * MAP_PX_METERS;
        const mz = originZ + (py + 0.5) * MAP_PX_METERS;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 255;

        if (world.groundSurface(mx, mz, this.top)) {
          const { grass, dirt, snow, spooky } = this.top;
          r = GRASS[0] * grass + DIRT[0] * dirt + SNOW[0] * snow;
          g = GRASS[1] * grass + DIRT[1] * dirt + SNOW[1] * snow;
          b = GRASS[2] * grass + DIRT[2] * dirt + SNOW[2] * snow;
          if (spooky > 0) {
            // Halloween ground: drained of colour and dark, like the real thing.
            const grey = 0.3 * r + 0.59 * g + 0.11 * b;
            const drain = spooky * GROUND.halloweenDesaturation;
            const dark = 1 - spooky * GROUND.halloweenDarkening;
            r = (r + (grey - r) * drain) * dark;
            g = (g + (grey - g) * drain) * dark;
            b = (b + (grey - b) * drain) * dark;
          }
          // Relief: lit from the up-left, so slopes read.
          if (world.groundSurface(mx - MAP_PX_METERS, mz - MAP_PX_METERS, this.neighbour)) {
            const dh = (this.top.height - this.neighbour.height) * RELIEF_PER_METER;
            const shade = 1 + Math.max(-RELIEF_MAX, Math.min(RELIEF_MAX, dh));
            r *= shade;
            g *= shade;
            b *= shade;
          }
        } else {
          a = 0;
        }

        const prop = blobAt(props, mx, mz);
        const tree = blobAt(trunks, mx, mz) ?? blobAt(canopies, mx, mz);
        const over = tree ?? prop;
        if (over !== undefined) {
          [r, g, b] = over.color;
          // Canopies are darker towards their rim, which separates a stand of trees.
          if (tree !== undefined && canopies.includes(tree)) {
            const d = ((tree.x - mx) ** 2 + (tree.z - mz) ** 2) / tree.radiusSq;
            const shade = 1.1 - 0.35 * d;
            r *= shade;
            g *= shade;
            b *= shade;
          }
          a = 255;
        }

        const i = (py * MAP_TILE_PX + px) * 4;
        tile[i] = r * 255;
        tile[i + 1] = g * 255;
        tile[i + 2] = b * 255;
        tile[i + 3] = a;
      }
    }
  }
}

function blobAt(blobs: Blob[], x: number, z: number): Blob | undefined {
  let best: Blob | undefined;
  for (const blob of blobs) {
    const dx = blob.x - x;
    const dz = blob.z - z;
    if (dx * dx + dz * dz > blob.radiusSq) continue;
    best = blob;
  }
  return best;
}

/** Horizontal reach of the foliage still attached, metres. 0 for a bare tree. */
function canopyRadius(tree: Tree): number {
  if (tree.severed) return 0;
  const foliage = TREE_METRICS[tree.species]?.foliage;
  if (foliage === undefined) return 0;
  let radius = 0;
  for (let i = 0; i < foliage.length; i++) {
    if ((tree.foliageMask & (1 << i)) === 0) continue;
    radius = Math.max(radius, (foliage[i] as { radiusXZ: number }).radiusXZ * tree.scale);
  }
  return radius;
}

function canopyColor(tree: Tree): readonly [number, number, number] {
  if (tree.species === TreeSpecies.Conifer) return CONIFER;
  return tree.biome === Biome.Halloween ? AUTUMN : BROADLEAF;
}
