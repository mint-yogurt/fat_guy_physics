import {
  Mesh,
  Sprite,
  SpriteMaterial,
  type Material,
  type Scene,
  type Texture,
} from "three/webgpu";

import type { ChunkKey } from "@fgp/shared/sim/chunkKey";
import type { ChunkResult } from "@fgp/shared/sim/chunkSource";
import { CHUNK_METERS, type ChunkSink, type PlacedRock, type Prop, type Tree } from "@fgp/shared/sim/world";
import { FLOATS_PER_VERTEX } from "@fgp/shared/voxel/vertexLayout";

import { applyMeshData, createChunkGeometry, disposeChunkGeometry } from "./chunkGeometry.ts";
import type { PropRenderer } from "./propRenderer.ts";
import type { TreeRenderer } from "./treeRenderer.ts";

/**
 * The client's half of streaming: turns World's chunk lifecycle events into
 * scene objects. Trees and props are forwarded to their own renderers, which
 * own the authored meshes; what is left here is chunk geometry and bush
 * sprites. Replaces the GL-owning parts of src/voxel/World.cpp
 * (ChunkMesh construction, World::draw).
 *
 * There is no per-frame work here at all. three.js walks the scene graph and
 * frustum-culls on its own, so the C++'s manual draw loop has no equivalent;
 * this class exists only to keep the scene reconciled with the loaded set and
 * -- the part that actually matters -- to make sure unloaded chunks have
 * their GPU buffers freed.
 */
export class WorldRenderer implements ChunkSink {
  private readonly meshes = new Map<ChunkKey, Mesh>();
  private readonly bushes = new Map<number, Sprite>();
  private bushMaterial: SpriteMaterial | undefined;

  constructor(
    private readonly scene: Scene,
    private readonly material: Material,
    /** Trees are meshes rather than chunk geometry, and own their own half. */
    private readonly trees: TreeRenderer,
    /** So are props, and they likewise draw themselves. */
    private readonly props: PropRenderer,
    private readonly bushTexture?: Texture,
  ) {}

  get meshCount(): number {
    return this.meshes.size;
  }

  onChunkLoaded(result: ChunkResult): void {
    // An empty chunk (solid rock, or pure air above the terrain) meshes to
    // zero vertices. Roughly half of a 4-layer vertical band is one or the
    // other, so skipping them here rather than adding empty Meshes keeps the
    // scene graph at about half the size for free.
    if (result.vertexCount === 0) return;

    // No copy: the buffer came from a worker as a transferable and is
    // already owned by this thread.
    this.addMesh(result.key, result.cx, result.cy, result.cz, result.vertices, result.vertexCount);
  }

  /** @param vertices must already be owned by this thread. */
  private addMesh(
    key: ChunkKey,
    cx: number,
    cy: number,
    cz: number,
    vertices: Float32Array,
    vertexCount: number,
  ): void {
    const object = new Mesh(createChunkGeometry(vertices, vertexCount), this.material);
    object.position.set(cx * CHUNK_METERS, cy * CHUNK_METERS, cz * CHUNK_METERS);
    // Chunk geometry is already in chunk-local metres and the only transform
    // is this translation, so there is nothing for three.js to recompute
    // after the first frame.
    object.matrixAutoUpdate = false;
    object.updateMatrix();

    this.scene.add(object);
    this.meshes.set(key, object);
  }

  /**
   * Replaces an edited chunk's geometry in place.
   *
   * `vertices` is the mesher's scratch, so it is copied. Digging can also
   * take a chunk to zero vertices (scooping out the last of a thin shelf)
   * or bring one back from zero -- neither is common, but both leave a
   * visible hole or a ghost block if unhandled.
   */
  onChunkRemeshed(
    key: ChunkKey,
    cx: number,
    cy: number,
    cz: number,
    vertices: Float32Array,
    vertexCount: number,
  ): void {
    const existing = this.meshes.get(key);

    if (vertexCount === 0) {
      if (existing !== undefined) this.onChunkUnloaded(key);
      return;
    }

    if (existing === undefined) {
      this.addMesh(key, cx, cy, cz, vertices.slice(0, vertexCount * FLOATS_PER_VERTEX), vertexCount);
      return;
    }

    applyMeshData(
      existing.geometry,
      vertices.slice(0, vertexCount * FLOATS_PER_VERTEX),
      vertexCount,
    );
  }

  onTreePlaced(tree: Tree): void {
    this.trees.onTreePlaced(tree);
  }

  onTreeFoliageRemoved(tree: Tree, cluster: number): void {
    this.trees.onTreeFoliageRemoved(tree, cluster);
  }

  onTreeLightsRemoved(tree: Tree): void {
    this.trees.onTreeLightsRemoved(tree);
  }

  onPropPlaced(prop: Prop): void {
    this.props.onPropPlaced(prop);
  }

  onPropUnloaded(propId: number): void {
    this.props.onPropUnloaded(propId);
  }

  onPropChanged(prop: Prop): void {
    this.props.onPropChanged(prop);
  }

  /** Where a rock the world has just placed goes: the game, which owns it from then on. */
  onRock: ((rock: PlacedRock) => void) | undefined = undefined;

  onRockPlaced(rock: PlacedRock): void {
    this.onRock?.(rock);
  }

  onTreeCut(
    tree: Tree,
    cutHeightMeters: number,
    pieceLengthMeters: number,
    carriedFoliage: number,
  ): void {
    this.trees.onTreeCut(tree, cutHeightMeters, pieceLengthMeters, carriedFoliage);
  }

  /** Scattered plants: one camera-facing sprite each, no geometry. */
  onBushPlaced(id: number, x: number, y: number, z: number, sizeMeters: number): void {
    if (this.bushTexture === undefined || this.bushes.has(id)) return;
    this.bushMaterial ??= new SpriteMaterial({
      map: this.bushTexture,
      // Cut out rather than blended: sorting hundreds of alpha-blended
      // sprites against each other is not worth it for foliage.
      alphaTest: 0.5,
      transparent: false,
    });
    const sprite = new Sprite(this.bushMaterial);
    sprite.scale.setScalar(sizeMeters);
    sprite.position.set(x, y + sizeMeters / 2, z);
    this.scene.add(sprite);
    this.bushes.set(id, sprite);
  }

  onTreeUnloaded(treeId: number): void {
    const bush = this.bushes.get(treeId);
    if (bush !== undefined) {
      this.bushes.delete(treeId);
      this.scene.remove(bush);
      return;
    }
    this.trees.onTreeUnloaded(treeId);
  }

  onChunkUnloaded(key: ChunkKey): void {
    const object = this.meshes.get(key);
    if (object === undefined) return; // was an empty chunk; never added
    this.meshes.delete(key);
    this.scene.remove(object);
    // Not optional. three.js does not free GPU buffers on garbage
    // collection, so a dereferenced geometry leaks its VBO for the lifetime
    // of the page -- and streaming churns hundreds of them per minute.
    disposeChunkGeometry(object.geometry);
  }

  /** Drops every chunk mesh. For teardown and for Vite's HMR dispose hook. */
  clear(): void {
    for (const object of this.meshes.values()) {
      this.scene.remove(object);
      disposeChunkGeometry(object.geometry);
    }
    this.meshes.clear();
    this.trees.clear();
    this.props.clear();
    for (const sprite of this.bushes.values()) this.scene.remove(sprite);
    this.bushes.clear();
    this.bushMaterial?.dispose();
    this.bushMaterial = undefined;
  }
}
