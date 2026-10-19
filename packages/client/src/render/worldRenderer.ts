import { Mesh, type Material, type Scene } from "three/webgpu";

import type { ChunkKey } from "@fgp/shared/sim/chunkKey";
import type { ChunkResult } from "@fgp/shared/sim/chunkSource";
import { CHUNK_METERS, type ChunkSink } from "@fgp/shared/sim/world";

import { createChunkGeometry, disposeChunkGeometry } from "./chunkGeometry.ts";

/**
 * The client's half of streaming: turns World's chunk lifecycle events into
 * scene objects. Replaces the GL-owning parts of src/voxel/World.cpp
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

  constructor(
    private readonly scene: Scene,
    private readonly material: Material,
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
    const object = new Mesh(
      createChunkGeometry(result.vertices, result.vertexCount),
      this.material,
    );
    object.position.set(
      result.cx * CHUNK_METERS,
      result.cy * CHUNK_METERS,
      result.cz * CHUNK_METERS,
    );
    // Chunk geometry is already in chunk-local metres and the only transform
    // is this translation, so there is nothing for three.js to recompute
    // after the first frame.
    object.matrixAutoUpdate = false;
    object.updateMatrix();

    this.scene.add(object);
    this.meshes.set(result.key, object);
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
  }
}
